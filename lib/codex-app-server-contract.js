// The supported Codex App Server surface is deliberately pinned rather than
// guessed from a semver range. GOL-472 generated these leaf schemas from the
// installed CLI and exercised the lifecycle used by the managed supervisor.
//
// What is gated is the SCHEMA, not the CLI version. An exact version equality
// check used to run first; it was removed because it gated on a proxy for the
// thing the next check measures directly, so every CLI update failed even when
// the protocol was byte-identical. `verifiedAgainstCliVersion` is recorded for
// diagnostics and is not enforced.
//
// Regenerate with: node scripts/regen-codex-contract.mjs [--write]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODEX_APP_SERVER_CONTRACT = Object.freeze({
  verifiedAgainstCliVersion: '0.146.0',
  schemaFingerprint: '6d94113943c180b05c1057f38db7b3faa5a655fbd5c5af4d3077dbb5165f5996',
  schemaFiles: Object.freeze({
    'ApplyPatchApprovalParams.json': '9de5a28a543214033b546db66ad8d34748a949c9878a7e51ec57a99feb2b8e67',
    'ApplyPatchApprovalResponse.json': '2b9fe9eec357d940bef643bb656707efea0889787f31c4e69c12e58606468a0e',
    'ClientRequest.json': '41188ef1f3507f7a6dfc238a935dabd39eaa71c954c27fb27e6c55c6d9dd8176',
    'CommandExecutionRequestApprovalParams.json': '0366a8c0590a270997f29f86c29bba119dad6d1be3e3e822c99532aea24a6a3e',
    'CommandExecutionRequestApprovalResponse.json': '42010a48dd9ad989171728c30338e1ff8144c31bd33921cbfb5608fd6c85a3b5',
    'ExecCommandApprovalParams.json': '6b34b7c6c999280f51146c8f44b08a368987c0c3624b02a89904330b0178cd9e',
    'ExecCommandApprovalResponse.json': 'd044005b62cb8de446cbaf7f598916974b5c6546b04f3fe552d7b8f880f069c7',
    'FileChangeRequestApprovalParams.json': '7b465f7c5671adffdc5c339f50799860950307456e2a2b52c5ce1d3018f4babd',
    'FileChangeRequestApprovalResponse.json': '7ccbd29e5f8840c7c8aa96c5c3b6d52bc71ec5c5d7e1ad05ab958afd44c0c94c',
    'PermissionsRequestApprovalParams.json': 'f40bc002f08d8a5ca6da7849778c6f262a0fc6fccafa00b30f9fac231312b29e',
    'PermissionsRequestApprovalResponse.json': 'e8669e089a78581a2f6c702dff906038032a6055c103c07870aa42c06b7fe3fb',
    'ServerNotification.json': '89608a4d65d713a85940f8eefb9bf2e87a94cbf2abac3ed069fad7cb6f078872',
    'ServerRequest.json': '5abe765ff9bd94b88f2f2fb417025ec011eac172925ffdfc74d7ccf2542bc114',
    'v1/InitializeParams.json': '4f576f99e285beb28f71f48a72b887c1f517dada86fee348fe2af0a35511de23',
    'v2/ListMcpServerStatusParams.json': '701916a7d444afbbc68aef9e72ab4e5c3111a8fd97560072e9b84713adf9ddc0',
    'v2/ListMcpServerStatusResponse.json': '9f57363d187ee9581e88cc2fe8ed85e4b692353ae96b616689e934702442af4a',
    'v2/ThreadForkParams.json': '80e4e29857a23617cbb59b30ef4ed3c4c51eadda3787d3c5de8b136a866a5b37',
    'v2/ThreadForkResponse.json': '960afd711e40bc47292cc424141d71675f2567464e30a86c2bf534711dfc2a81',
    'v2/ThreadNameUpdatedNotification.json': '7cd55307c0343508b226b9fe87cb7af09711fb438cdeb5eb440cf37a5d2f5000',
    'v2/ThreadResumeParams.json': '2e1d4b62bc09b46ebc54ef9f84fcdd6ca8d37cabb98dedc34b49761ee764c84d',
    'v2/ThreadResumeResponse.json': 'a45d7f2456df5e173bb54e762ac8efe475ff69a77b5a6f9035fb6a20bc8d2363',
    'v2/ThreadStartedNotification.json': '1f0ae4f8617012bdd16683c89b5b95296a1fa148a86ba0a13251a693fd7604c4',
    'v2/ThreadStartParams.json': 'b3685411ceb8ad264a1920e8facd66301e5280948ef9c2a6871b95d4c19da639',
    'v2/ThreadStartResponse.json': 'c2899f35029734ed42c3d3b02b6077f0bebaf7724cbc655aead83bb1aa2adadf',
    'v2/ThreadStatusChangedNotification.json': '146af6d3702c4f3c844bd10b6b6b3e2b872e958a8d7d822157c19aaa6dc085f6',
    'v2/TurnCompletedNotification.json': '5b5f2ca515658ea6fcce7e961d1c3feddb3f48c0dcc813260c7ccf77a2d016af',
    'v2/TurnStartParams.json': 'f23021c02d28b60fccb6dcaaace9ff676127065f8254537265d6622656860dca',
    'v2/TurnStartResponse.json': '099184dc9d6195cd965b8a90ee5d1cb05c87d9b329acecdfbd63f358e660d568',
    'v2/TurnSteerParams.json': '802b236f03d4a691c3bfc6d2e8b76a3592dab1f7593ac6e520aed762fb397898',
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
  const changed = [];
  const observed = Object.entries(contract.schemaFiles)
    .map(([relative, expected]) => {
      const schema = path.join(root, relative);
      let actual;
      try {
        actual = sha256(fs.readFileSync(schema));
      } catch {
        changed.push(`${relative} (no longer emitted by this CLI)`);
        return [relative, null];
      }
      if (actual !== expected) changed.push(relative);
      return [relative, actual];
    })
    .sort(([left], [right]) => left.localeCompare(right));
  // Report every drifted leaf at once. Throwing on the first one meant a real
  // protocol update had to be discovered one file per run.
  if (changed.length) {
    throw new Error(
      `Codex App Server is disabled: ${changed.length} of ${observed.length} schema leaves changed since the contract was pinned `
      + `(verified against codex-cli ${contract.verifiedAgainstCliVersion ?? contract.cliVersion}).\n`
      + changed.map((relative) => `  - ${relative}`).join('\n')
      + '\n  Review these against how the supervisor uses them, then run: node scripts/regen-codex-contract.mjs --write',
    );
  }
  return sha256(JSON.stringify(observed));
}

/**
 * Verify the exact App Server schema before a managed supervisor is allowed to
 * start. This intentionally regenerates the schema for every launch: a stale
 * cache would turn a version gate into a best-effort hint.
 */
export function verifyCodexAppServerContract({ command = 'codex', contract = CODEX_APP_SERVER_CONTRACT } = {}) {
  // Version is recorded, never gated: the schema comparison below is the real
  // check, and it is strictly more precise. A CLI upgrade that does not touch
  // the protocol must not disable the supervisor.
  const cliVersion = readCodexVersion(command);
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
