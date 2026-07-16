// The supported Codex App Server surface is deliberately pinned rather than
// guessed from a semver range. GOL-472 generated these leaf schemas from the
// installed CLI and exercised the lifecycle used by the managed supervisor.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODEX_APP_SERVER_CONTRACT = Object.freeze({
  cliVersion: '0.144.5',
  schemaFingerprint: '8fea722bf38d19e54265e4650f36e9329bac40d334c1c287d12bb6d21c8eac71',
  schemaFiles: Object.freeze({
    'ApplyPatchApprovalParams.json': '9de5a28a543214033b546db66ad8d34748a949c9878a7e51ec57a99feb2b8e67',
    'ApplyPatchApprovalResponse.json': '1b1c691b986c23e8dd91a182e716d0366de6ec69bf62f83f208efa9f4c53e6ee',
    'ClientRequest.json': 'd8474445e109c242a2cc1169ed6d8644f86df3a097230c8c52bdc107a9014efa',
    'CommandExecutionRequestApprovalParams.json': '252b95dd7223b86d3bb7e786eb819a40d66dc36514e77c4221ea72c7cd5cad7c',
    'CommandExecutionRequestApprovalResponse.json': '42010a48dd9ad989171728c30338e1ff8144c31bd33921cbfb5608fd6c85a3b5',
    'ExecCommandApprovalParams.json': '6b34b7c6c999280f51146c8f44b08a368987c0c3624b02a89904330b0178cd9e',
    'ExecCommandApprovalResponse.json': '2582a07c4028d06e0ed67c1b7563469882bbc66640237be182d309fe4ad1d1eb',
    'FileChangeRequestApprovalParams.json': '7b465f7c5671adffdc5c339f50799860950307456e2a2b52c5ce1d3018f4babd',
    'FileChangeRequestApprovalResponse.json': '7ccbd29e5f8840c7c8aa96c5c3b6d52bc71ec5c5d7e1ad05ab958afd44c0c94c',
    'PermissionsRequestApprovalParams.json': '1d3d82089f06c19f1ab7c5a8790aad7c8ae8cafb3ebcf48458947cedcc201254',
    'PermissionsRequestApprovalResponse.json': '60abc8a0d1c1f24be5be8fafbeb8a2bd0c327ba44088c74ba414b31acdfd4489',
    'ServerRequest.json': '886f30bd882a73600566695e0f08f8a10fcd9897742c4745ecf91710ec256f6a',
    'ServerNotification.json': 'fb0d6bf6b9f192257f452340de3fdca6b4b2c8e1a216aafaf48837a006e14bea',
    'v1/InitializeParams.json': '4f576f99e285beb28f71f48a72b887c1f517dada86fee348fe2af0a35511de23',
    'v2/ListMcpServerStatusParams.json': '701916a7d444afbbc68aef9e72ab4e5c3111a8fd97560072e9b84713adf9ddc0',
    'v2/ListMcpServerStatusResponse.json': '9f57363d187ee9581e88cc2fe8ed85e4b692353ae96b616689e934702442af4a',
    'v2/ThreadResumeParams.json': 'f828ee9846f11a68a1d259429ae147ddd49fcbd1cfb860b1a83f41604a5e97b9',
    'v2/ThreadResumeResponse.json': '9d1eb57cf2baa00ae2b1f747a10f450bc8dcd9e400a58d6945c0d803af633dd1',
    'v2/ThreadForkParams.json': '26cd7019c1799698502657e4279eb08530c2625b2cab38c22b3ca74a126d3dbb',
    'v2/ThreadForkResponse.json': 'e4aee380dc44c4d6df683458fc98477249f4c7e2f1656479fa664928ba72131a',
    'v2/ThreadNameUpdatedNotification.json': '7cd55307c0343508b226b9fe87cb7af09711fb438cdeb5eb440cf37a5d2f5000',
    'v2/ThreadStartParams.json': '4f30cb90cae47ff01adba8d863228b2aa198232df895dbfc996d594270326744',
    'v2/ThreadStartResponse.json': 'eb5135241a7806db436100493c91214ef3516c4a9bd9aae700abc418c71be132',
    'v2/ThreadStartedNotification.json': '49ecfc7478d824b9b31a38e89099c44bc1f5e5a9d9a6dda3221184a11d158e7c',
    'v2/ThreadStatusChangedNotification.json': '146af6d3702c4f3c844bd10b6b6b3e2b872e958a8d7d822157c19aaa6dc085f6',
    'v2/TurnCompletedNotification.json': '900bc6e40f0aeb5aa498ec874f026a2a077356ac1dc740c1928cfdca29630345',
    'v2/TurnStartParams.json': 'a28f74287e18b8a18c7aa6966ee7552a8ed2ae13c03f4ba12e9af48f7370f19d',
    'v2/TurnStartResponse.json': '7cfae42a4652fe38119d6a0a625910357c869c448c985513a4cd5966031e18bc',
    'v2/TurnSteerParams.json': '2c5a7ff12f952bab1b829bcae1afd2f79217b87f48ba296581ea3b3888eedabb',
    'v2/TurnSteerResponse.json': 'a669b85e3b75b86468e39e6a2f760966bffe83f378b514c6898fb04b838cd78d',
  }),
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readCodexVersion(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Codex App Server is disabled: ${command} --version failed: ${result.error?.message || result.stderr || result.stdout || 'unknown error'}`);
  }
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const match = output.match(/codex-cli\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
  if (!match) throw new Error(`Codex App Server is disabled: could not parse codex-cli version from ${JSON.stringify(output.trim())}`);
  return match[1];
}

export function fingerprintCodexAppServerSchema(root, contract = CODEX_APP_SERVER_CONTRACT) {
  const observed = Object.entries(contract.schemaFiles)
    .map(([relative, expected]) => {
      const schema = path.join(root, relative);
      const actual = sha256(fs.readFileSync(schema));
      if (actual !== expected) {
        throw new Error(`Codex App Server is disabled: schema leaf changed (${relative}); review and update the GOL-472 contract before starting a supervisor`);
      }
      return [relative, actual];
    })
    .sort(([left], [right]) => left.localeCompare(right));
  return sha256(JSON.stringify(observed));
}

/**
 * Verify the exact App Server schema before a managed supervisor is allowed to
 * start. This intentionally regenerates the schema for every launch: a stale
 * cache would turn a version gate into a best-effort hint.
 */
export function verifyCodexAppServerContract({ command = 'codex', contract = CODEX_APP_SERVER_CONTRACT } = {}) {
  const cliVersion = readCodexVersion(command);
  if (cliVersion !== contract.cliVersion) {
    throw new Error(`Codex App Server is disabled: expected codex-cli ${contract.cliVersion}, found ${cliVersion}. Regenerate and review the schema contract before retrying.`);
  }
  const generated = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-codex-app-server-schema-'));
  try {
    const result = spawnSync(command, ['app-server', 'generate-json-schema', '--experimental', '--out', generated], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw new Error(`Codex App Server is disabled: schema generation failed: ${result.error?.message || result.stderr || result.stdout || 'unknown error'}`);
    }
    const schemaFingerprint = fingerprintCodexAppServerSchema(generated, contract);
    if (schemaFingerprint !== contract.schemaFingerprint) {
      throw new Error(`Codex App Server is disabled: expected schema ${contract.schemaFingerprint}, found ${schemaFingerprint}. Regenerate and review the contract before retrying.`);
    }
    return Object.freeze({
      cli_version: cliVersion,
      schema_fingerprint: schemaFingerprint,
      checked_at: new Date().toISOString(),
    });
  } finally {
    fs.rmSync(generated, { recursive: true, force: true });
  }
}
