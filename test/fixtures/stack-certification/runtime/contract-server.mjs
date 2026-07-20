import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform } from 'fastify-type-provider-zod';
import createClient from 'openapi-fetch';
import WebSocket from 'ws';
import { EchoInput, EchoOutput } from './schema.mjs';

function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr || stdout}`));
    });
  });
}

function receiveJson(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (raw) => resolve(JSON.parse(String(raw))));
    socket.once('error', reject);
  });
}

export async function certifyContractBoundary({ fixtureRoot, generatedRoot, env }) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Golem stack certification', version: '1.0.0' }
    },
    transform: jsonSchemaTransform
  });
  await app.register(websocket);
  app.post('/echo', {
    schema: { body: EchoInput, response: { 200: EchoOutput } }
  }, async (request) => ({ message: request.body.message }));
  app.get('/broken-response', {
    schema: { response: { 200: EchoOutput } }
  }, async () => ({ message: '' }));
  app.get('/events', { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ event: 'snapshot', cursor: 'c1' }));
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.action === 'resume' && message.cursor === 'c1') {
        socket.send(JSON.stringify({ event: 'resumed', cursor: 'c1' }));
      }
    });
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(address && typeof address === 'object', 'Fastify did not bind a loopback address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const artifactRoot = await mkdtemp(join(generatedRoot, 'openapi-'));
  try {
    const specPath = join(artifactRoot, 'openapi.json');
    await writeFile(specPath, `${JSON.stringify(app.swagger(), null, 2)}\n`);
    const typesPath = join(artifactRoot, 'openapi.d.ts');
    await run(process.execPath, [
      join(fixtureRoot, 'tools', 'openapi-codegen', 'generate.mjs'), specPath, typesPath
    ], fixtureRoot, env);
    const spec = JSON.parse(await readFile(specPath, 'utf8'));
    assert(spec.paths['/echo']?.post, 'OpenAPI document omitted POST /echo');
    const generatedTypes = await readFile(typesPath, 'utf8');
    assert.match(generatedTypes, /["']\/echo["']\s*:/, 'generated client types omitted /echo');
    const generatedClientPath = join(artifactRoot, 'generated-client.ts');
    await writeFile(generatedClientPath, `import createClient from 'openapi-fetch';\nimport type { paths } from './openapi.js';\nexport const client = createClient<paths>({ baseUrl: 'http://127.0.0.1' });\n`);
    await run(process.execPath, [
      join(fixtureRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2024', generatedClientPath
    ], fixtureRoot, env);

    const client = createClient({ baseUrl });
    const good = await client.POST('/echo', { body: { message: 'contract' } });
    assert.equal(good.response.status, 200);
    assert.deepEqual(good.data, { message: 'contract' });
    const invalid = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '' })
    });
    assert.equal(invalid.status, 400);
    const broken = await fetch(`${baseUrl}/broken-response`);
    assert.equal(broken.status, 500);

    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/events`);
    await once(socket, 'open');
    const snapshot = await receiveJson(socket);
    assert.deepEqual(snapshot, { event: 'snapshot', cursor: 'c1' });
    socket.send(JSON.stringify({ action: 'resume', cursor: 'c1' }));
    const resumed = await receiveJson(socket);
    assert.deepEqual(resumed, { event: 'resumed', cursor: 'c1' });
    socket.close();
    return { baseUrl, openapiPaths: Object.keys(spec.paths), generatedClient: 'root-typescript-7', websocket: resumed.event };
  } finally {
    await app.close();
    await rm(artifactRoot, { force: true, recursive: true });
  }
}
