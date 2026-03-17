#!/usr/bin/env node
/**
 * Auto-detect GPU and run Tauri with appropriate features
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function run(command, cwd, env) {
  execSync(command, { stdio: 'inherit', cwd, env });
}

function appendPath(env, extraPath) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = `${extraPath}${path.delimiter}${env[pathKey] || ''}`;
  if (pathKey !== 'PATH') {
    env.PATH = env[pathKey];
  }
  if (pathKey !== 'Path') {
    env.Path = env[pathKey];
  }
}

function findWorkspaceRoot(frontendDir) {
  const candidate = path.resolve(frontendDir, '..');
  return fs.existsSync(path.join(candidate, 'Cargo.toml')) ? candidate : frontendDir;
}

function detectTargetTriple() {
  return execSync('rustc -vV', { encoding: 'utf8' })
    .split(/\r?\n/)
    .find((line) => line.startsWith('host:'))
    ?.split(':')[1]
    ?.trim();
}

function stageLlamaHelper(frontendDir, feature, env, buildMode) {
  const workspaceRoot = findWorkspaceRoot(frontendDir);
  const helperDir = path.join(workspaceRoot, 'llama-helper');
  if (!fs.existsSync(path.join(helperDir, 'Cargo.toml'))) {
    throw new Error(`Could not find llama-helper directory at ${helperDir}`);
  }

  const llamaFeature = feature === 'coreml' ? 'metal' : feature;
  const helperArgs = ['cargo', 'build'];
  if (buildMode === 'build') {
    helperArgs.push('--release');
  }
  if (llamaFeature && llamaFeature !== 'none') {
    helperArgs.push('--features', llamaFeature);
  }

  console.log(`🦙 Building llama-helper sidecar (${buildMode})...`);
  run(helperArgs.join(' '), helperDir, env);

  const targetTriple = detectTargetTriple();
  if (!targetTriple) {
    throw new Error('Unable to determine Rust target triple');
  }

  const profileDir = buildMode === 'build' ? 'release' : 'debug';
  const helperBinaryName = os.platform() === 'win32' ? 'llama-helper.exe' : 'llama-helper';
  const helperBinary = path.join(workspaceRoot, 'target', profileDir, helperBinaryName);
  if (!fs.existsSync(helperBinary)) {
    throw new Error(`Built llama-helper binary not found at ${helperBinary}`);
  }

  const binariesDir = path.join(frontendDir, 'src-tauri', 'binaries');
  fs.mkdirSync(binariesDir, { recursive: true });
  for (const entry of fs.readdirSync(binariesDir)) {
    if (entry.startsWith('llama-helper')) {
      fs.rmSync(path.join(binariesDir, entry), { force: true });
    }
  }

  const stagedBinaryName = os.platform() === 'win32'
    ? `llama-helper-${targetTriple}.exe`
    : `llama-helper-${targetTriple}`;
  fs.copyFileSync(helperBinary, path.join(binariesDir, stagedBinaryName));
  console.log(`📦 Staged llama-helper as ${stagedBinaryName}`);
}

// Get the command (dev or build)
const command = process.argv[2];
if (!command || !['dev', 'build'].includes(command)) {
  console.error('Usage: node tauri-auto.js [dev|build]');
  process.exit(1);
}

// Detect GPU feature
let feature = '';

// Check for environment variable override first
if (process.env.TAURI_GPU_FEATURE) {
  feature = process.env.TAURI_GPU_FEATURE;
  console.log(`🔧 Using forced GPU feature from environment: ${feature}`);
} else {
  try {
    const result = execSync('node scripts/auto-detect-gpu.js', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit']
    });
    feature = result.trim();
  } catch (err) {
    // If detection fails, continue with no features
  }
}

console.log(''); // Empty line for spacing

// Platform-specific environment variables
const platform = os.platform();
const env = { ...process.env };
const frontendDir = path.resolve(__dirname, '..');

if (platform === 'win32') {
  const llvmBin = 'C:\\Program Files\\LLVM\\bin';
  if (fs.existsSync(path.join(llvmBin, 'libclang.dll'))) {
    env.LIBCLANG_PATH = llvmBin;
    appendPath(env, llvmBin);
  }

  const clFlags = '/utf-8';
  env.CL = env.CL ? `${env.CL} ${clFlags}` : clFlags;
  const bindgenArgs = ['--target=x86_64-pc-windows-msvc'];
  const includeEnv = env.INCLUDE || env.Include || '';
  for (const includePath of includeEnv.split(';').filter(Boolean)) {
    bindgenArgs.push(`-I${includePath}`);
  }
  const bindgenArgString = bindgenArgs.join(' ');
  env.BINDGEN_EXTRA_CLANG_ARGS = env.BINDGEN_EXTRA_CLANG_ARGS
    ? `${env.BINDGEN_EXTRA_CLANG_ARGS} ${bindgenArgString}`
    : bindgenArgString;
  env.BINDGEN_EXTRA_CLANG_ARGS_x86_64_pc_windows_msvc = bindgenArgString;
  env['BINDGEN_EXTRA_CLANG_ARGS_x86_64-pc-windows-msvc'] = bindgenArgString;
}

if (platform === 'linux' && feature === 'cuda') {
  console.log('🐧 Linux/CUDA detected: Setting CMAKE flags for NVIDIA GPU');
  env.CMAKE_CUDA_ARCHITECTURES = '75';
  env.CMAKE_CUDA_STANDARD = '17';
  env.CMAKE_POSITION_INDEPENDENT_CODE = 'ON';
}

// Build the tauri command
let tauriCmd = `tauri ${command}`;
if (feature && feature !== 'none') {
  tauriCmd += ` -- --features ${feature}`;
  console.log(`🚀 Running: tauri ${command} with features: ${feature}`);
} else {
  console.log(`🚀 Running: tauri ${command} (CPU-only mode)`);
}
console.log('');

// Execute the command
try {
  stageLlamaHelper(frontendDir, feature, env, command);
  execSync(tauriCmd, { stdio: 'inherit', env, cwd: frontendDir });
} catch (err) {
  process.exit(err.status || 1);
}
