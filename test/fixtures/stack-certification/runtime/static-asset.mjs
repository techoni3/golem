import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

export async function certifyStaticAsset(distRoot) {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: distRoot });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert(address && typeof address === 'object', 'static server did not bind a loopback address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const index = await fetch(`${baseUrl}/`);
    assert.equal(index.status, 200);
    const indexHtml = await index.text();
    const assetMatch = indexHtml.match(/src="([^\"]+\.js)"/);
    assert(assetMatch, 'Vite index did not reference a JavaScript asset');
    const asset = await fetch(`${baseUrl}${assetMatch[1]}`);
    assert.equal(asset.status, 200);
    const onDisk = await readFile(join(distRoot, assetMatch[1]), 'utf8');
    assert(onDisk.includes('stack-certification'), 'served Vite asset did not contain the React fixture marker');
    return { asset: assetMatch[1], baseUrl };
  } finally {
    await app.close();
  }
}
