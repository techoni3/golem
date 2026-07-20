import { runCertificationMessage } from '@golem-stack/app';

const result = runCertificationMessage({ message: '  typed build  ' });
if (result.message !== 'typed build') {
  throw new Error(`unexpected compiled workspace result: ${JSON.stringify(result)}`);
}

process.stdout.write(`${JSON.stringify(result)}\n`);
