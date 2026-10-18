// ST-63 as far as it can be proven without a server (M4-BE-08):
//
//   node deploy/checks/deploy-gate.mjs
//
// Builds a test container with an SSH server set up exactly as deploy/server/ describes it (the
// sshd snippet, the forced command, the sudoers rule, the deploy script and its configuration)
// and a stand-in for docker, and runs deploy/checks/st-63/scenarios.sh in it: a deploy key hands
// over a digest and nothing else; it opens no shell, terminal, forward or file transfer; one
// repository's key cannot deploy the other's image; the deploy script refuses anything but a
// digest. Needs Docker; touches nothing outside its own container, which it removes.
// Log: .artifacts/deploy-checks/st-63.log.
import { CHECK_PREFIX, createLog, docker, dockerOk } from './lib.mjs';

const image = `${CHECK_PREFIX}-st63:check`;
const container = `${CHECK_PREFIX}-st63`;
const log = createLog('st-63');

let code = 1;
try {
  process.stdout.write(`Building ${image} ...\n`);
  log.write(
    dockerOk(['build', '--quiet', '--file', 'deploy/checks/st-63/Dockerfile', '--tag', image, '.']),
  );
  docker(['rm', '--force', container]);
  const result = docker(['run', '--rm', '--name', container, '--network', 'none', image]);
  process.stdout.write(result.stdout);
  log.write(result.stdout);
  if (result.stderr) log.write(result.stderr);
  code = result.code;
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  log.write(String(error));
} finally {
  docker(['rm', '--force', container]);
  docker(['image', 'rm', '--force', image]);
}
process.stdout.write(
  `\nST-63 (local part): ${code === 0 ? 'passed' : 'FAILED'}; log ${log.file}\n`,
);
process.exit(code === 0 ? 0 : 1);
