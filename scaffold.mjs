import { spawn } from 'child_process';
const child = spawn(
  'cmd',
  ['/c', 'npx --yes @quick-start/create-electron apps/electron-vue-pinia --template vue-ts'],
  {
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
child.stdout.on('data', (data) => {
  const output = data.toString();
  process.stdout.write(output);
  if (output.includes('Project name:') || output.includes('Package name:')) {
    child.stdin.write('\r\n');
  }
  if (output.includes('Add Vue Router?')) {
    child.stdin.write('\r\n'); // No
  }
  if (output.includes('Add Pinia')) {
    child.stdin.write('y\r\n'); // Yes
  }
  if (output.includes('Add ESLint')) {
    child.stdin.write('n\r\n'); // No
  }
  if (output.includes('Add Prettier')) {
    child.stdin.write('n\r\n'); // No
  }
  if (output.includes('Add TypeScript')) {
    child.stdin.write('y\r\n'); // Yes
  }
  if (output.includes('Add Electron updater plugin')) {
    child.stdin.write('\r\n'); // No
  }
  if (output.includes('Enable Electron download mirror')) {
    child.stdin.write('\r\n'); // No
  }
});
child.stderr.on('data', (data) => {
  process.stderr.write(data.toString());
});
child.on('close', (code) => {
  console.log(`child process exited with code ${code}`);
});
