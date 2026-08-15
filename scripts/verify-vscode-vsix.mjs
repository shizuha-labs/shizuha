#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const vsix = resolve(process.argv[2] || '');
const expectedSha = (process.argv[3] || process.env.GITHUB_SHA || '').trim();
const expectedVersion = (process.argv[4] || process.env.EXPECTED_VERSION || '').trim();
if (!vsix || !expectedSha || !expectedVersion) {
  console.error('usage: verify-vscode-vsix.mjs <path.vsix> <40-char-source-sha> <expected-version>');
  process.exit(2);
}
if (!/^[0-9a-f]{40}$/i.test(expectedSha)) throw new Error('invalid source SHA: ' + expectedSha);
// Marketplace production is stable-only. Pre-release and platform-specific
// packages use separate reviewed channels; silently accepting either here can
// publish different bytes/visibility than the release evidence describes.
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(expectedVersion)) {
  throw new Error('invalid expected release version: ' + expectedVersion);
}

execFileSync('unzip', ['-tqq', vsix], { stdio: 'pipe' });
const listing = execFileSync('unzip', ['-Z1', vsix], { encoding: 'utf8' }).trim().split('\n');
const expectedEntries = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/LICENSE.txt',
  'extension/SOURCE_SHA',
  'extension/changelog.md',
  'extension/dist/extensions/vscode/src/chat-state.js',
  'extension/dist/extensions/vscode/src/chat-webview.js',
  'extension/dist/extensions/vscode/src/extension.js',
  'extension/dist/extensions/vscode/src/file-diff.js',
  'extension/dist/extensions/vscode/src/lifecycle.js',
  'extension/dist/extensions/vscode/src/provider-settings.js',
  'extension/dist/extensions/vscode/src/run-monitor.js',
  'extension/dist/src/local-core-protocol.js',
  'extension/images/icon.png',
  'extension/media/chat.css',
  'extension/media/chat.js',
  'extension/package.json',
  'extension/readme.md',
];

if (new Set(listing).size !== listing.length) throw new Error('VSIX contains duplicate entry names');
for (const path of listing) {
  if (!path || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new Error('VSIX contains an absolute or malformed entry: ' + JSON.stringify(path));
  }
  if (path.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('VSIX contains a traversal entry: ' + path);
  }
  if (/[^\x20-\x7e]/.test(path)) throw new Error('VSIX contains a control/non-ASCII entry name');
}
const actualSorted = [...listing].sort();
if (JSON.stringify(actualSorted) !== JSON.stringify(expectedEntries)) {
  const expected = new Set(expectedEntries);
  const actual = new Set(listing);
  const unexpected = listing.filter((path) => !expected.has(path));
  const missing = expectedEntries.filter((path) => !actual.has(path));
  throw new Error(`VSIX closed manifest mismatch\nmissing: ${missing.join(', ') || '(none)'}\nunexpected: ${unexpected.join(', ') || '(none)'}`);
}

const typedListing = execFileSync('unzip', ['-Z', '-l', vsix], { encoding: 'utf8' })
  .split('\n')
  .filter((line) => /^[-dlcbps]/.test(line));
if (typedListing.length !== listing.length || typedListing.some((line) => !line.startsWith('-'))) {
  throw new Error('VSIX contains a directory, symlink, device, or unknown entry type');
}

const forbidden = listing.filter((path) =>
  /(^|\/)(\.env[^/]*|\.npmrc|\.yarnrc|node_modules|tests?|__tests__)(\/|$)/i.test(path)
  || path.startsWith('extension/src/')
  || /\.(ts|map|pem|key|p12|pfx|jks|keystore)$/i.test(path)
);
if (forbidden.length) throw new Error('VSIX contains forbidden development/secret artifacts:\n' + forbidden.join('\n'));

const manifest = JSON.parse(execFileSync('unzip', ['-p', vsix, 'extension/package.json'], { encoding: 'utf8' }));
const exact = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label} mismatch: ${JSON.stringify(actual)}`);
};
const exactJson = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: ${JSON.stringify(actual)}`);
  }
};
exactJson(Object.keys(manifest).sort(), [
  'activationEvents', 'bugs', 'capabilities', 'categories', 'contributes',
  'description', 'devDependencies', 'displayName', 'engines', 'extensionKind',
  'galleryBanner', 'homepage', 'icon', 'keywords', 'license', 'main', 'name',
  'pricing', 'publisher', 'repository', 'scripts', 'version',
].sort(), 'package top-level semantic graph');
exact(manifest.publisher, 'shizuha', 'publisher');
exact(manifest.name, 'shizuha-vscode', 'extension name');
exact(manifest.version, expectedVersion, 'release version');
exact(manifest.displayName, 'Shizuha', 'display name');
exact(manifest.main, './dist/extensions/vscode/src/extension.js', 'extension main');
exact(manifest.engines?.vscode, '^1.92.0', 'VS Code engine');
exact(manifest.license, 'AGPL-3.0-only', 'license');
exact(manifest.icon, 'images/icon.png', 'icon');
exact(manifest.description, 'Chat with Shizuha, monitor local agent runs, configure providers, and review file edits without leaving VS Code.', 'description');
const expectedActivationEvents = [
  'onStartupFinished',
  'onCommand:shizuha.retryConnect',
  'onCommand:shizuha.disconnect',
  'onCommand:shizuha.openChat',
  'onCommand:shizuha.configureProviderModel',
  'onCommand:shizuha.cancelRun',
  'onCommand:shizuha.showRuns',
  'onView:shizuhaRuns',
];
exactJson(manifest.activationEvents, expectedActivationEvents, 'activation events');
exactJson(manifest.contributes, {
  configuration: {
    title: 'Shizuha',
    properties: {
      'shizuha.coreEndpoint': {
        type: 'string', default: 'http://127.0.0.1:8015',
        description: 'Local Shizuha core endpoint. The extension connects to the installed CLI service; it does not bundle an agent.',
      },
      'shizuha.expectedProtocolVersion': {
        type: 'string', default: 'scli-133.v1', description: 'Expected local core protocol version.',
      },
      'shizuha.defaultProvider': {
        type: 'string', default: '', description: 'Default provider for Shizuha chat runs. Non-secret; configured through the local core provider command.',
      },
      'shizuha.defaultModel': {
        type: 'string', default: '', description: 'Default model id for Shizuha chat runs. Non-secret; configured through the local core provider command.',
      },
    },
  },
  commands: [
    { command: 'shizuha.retryConnect', title: 'Shizuha: Retry/Start Local Core' },
    { command: 'shizuha.disconnect', title: 'Shizuha: Disconnect Session' },
    { command: 'shizuha.openChat', title: 'Shizuha: Open Chat' },
    { command: 'shizuha.configureProviderModel', title: 'Shizuha: Configure Provider and Model' },
    { command: 'shizuha.cancelRun', title: 'Shizuha: Cancel Current Run' },
    { command: 'shizuha.showRuns', title: 'Shizuha: Show Agent Runs' },
  ],
  views: { explorer: [{ id: 'shizuhaRuns', name: 'Shizuha Runs' }] },
}, 'complete contributes graph');
exactJson(manifest.scripts, {
  'vscode:prepublish': 'npm run compile',
  compile: 'tsc -p ./tsconfig.json',
  package: 'vsce package --no-dependencies',
  'package:list': 'vsce ls --tree',
  'publish:marketplace': 'vsce publish --no-dependencies',
}, 'package scripts');
exactJson(manifest.devDependencies, {
  '@types/vscode': '^1.92.0',
  typescript: '^5.7.0',
  '@types/node': '^22.0.0',
  '@vscode/vsce': '3.9.1',
}, 'package development dependencies');
exactJson(manifest.extensionKind, ['ui', 'workspace'], 'extension kind');
exactJson(manifest.extensionDependencies, undefined, 'extension dependencies');
exactJson(manifest.extensionPack, undefined, 'extension pack');
exactJson(manifest.enabledApiProposals, undefined, 'enabled API proposals');
exactJson(manifest.categories, ['Other'], 'categories');
exactJson(manifest.keywords, ['ai', 'agent', 'chat', 'code-review', 'diff', 'shizuha'], 'keywords');
exact(manifest.homepage, 'https://shizuha.com', 'homepage');
exact(manifest.repository?.type, 'git', 'repository type');
exact(manifest.repository?.url, 'https://github.com/shizuha-labs/shizuha.git', 'repository URL');
exact(manifest.repository?.directory, 'extensions/vscode', 'repository directory');
exact(manifest.bugs?.url, 'https://github.com/shizuha-labs/shizuha/issues', 'bugs URL');
exact(manifest.pricing, 'Free', 'pricing');
exactJson(manifest.galleryBanner, { color: '#4f46e5', theme: 'dark' }, 'gallery banner');
exactJson(manifest.capabilities, {
  untrustedWorkspaces: {
    supported: false,
    description: 'Shizuha does not activate until the workspace is trusted because it starts a local process, opens a session, resolves provider secrets, and can apply file edits.',
  },
  virtualWorkspaces: { supported: false },
}, 'workspace capabilities');

const xml = execFileSync('unzip', ['-p', vsix, 'extension.vsixmanifest'], { encoding: 'utf8' });
const validXml = XMLValidator.validate(xml, { allowBooleanAttributes: false });
if (validXml !== true) throw new Error(`VSIX XML is malformed: ${validXml.err.msg}`);
const parsedXml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  processEntities: false,
  allowBooleanAttributes: false,
  trimValues: true,
}).parse(xml);
const one = (value, label) => {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error(`VSIX XML requires exactly one ${label}`);
    return value[0];
  }
  if (value === undefined || value === null) throw new Error(`VSIX XML is missing ${label}`);
  return value;
};
const packageXml = one(parsedXml?.PackageManifest, 'PackageManifest');
exact(packageXml.Version, '2.0.0', 'VSIX XML schema version');
exact(packageXml.xmlns, 'http://schemas.microsoft.com/developer/vsx-schema/2011', 'VSIX XML namespace');
const metadata = one(packageXml.Metadata, 'Metadata');
const identity = one(metadata.Identity, 'Identity');
exact(identity.Id, manifest.name, 'VSIX XML identity name');
exact(identity.Publisher, manifest.publisher, 'VSIX XML publisher');
exact(identity.Version, expectedVersion, 'VSIX XML version');
exact(identity.Language, 'en-US', 'VSIX XML language');
if ('TargetPlatform' in identity || 'PreRelease' in identity) throw new Error('VSIX XML platform/pre-release metadata is not authorized');
exact(one(metadata.DisplayName, 'DisplayName'), 'Shizuha', 'VSIX XML display name');
exact(one(metadata.License, 'License'), 'extension/LICENSE.txt', 'VSIX XML license');
exact(one(metadata.Icon, 'Icon'), 'extension/images/icon.png', 'VSIX XML icon');

const properties = [].concat(one(metadata.Properties, 'Properties').Property || []);
const propertyMap = new Map();
for (const property of properties) {
  if (!property?.Id || propertyMap.has(property.Id)) throw new Error('VSIX XML contains duplicate/invalid Property');
  propertyMap.set(property.Id, property.Value ?? '');
}
const expectedProperties = new Map([
  ['Microsoft.VisualStudio.Code.Engine', '^1.92.0'],
  ['Microsoft.VisualStudio.Code.ExtensionDependencies', ''],
  ['Microsoft.VisualStudio.Code.ExtensionPack', ''],
  ['Microsoft.VisualStudio.Code.ExtensionKind', 'ui,workspace'],
  ['Microsoft.VisualStudio.Code.LocalizedLanguages', ''],
  ['Microsoft.VisualStudio.Code.EnabledApiProposals', ''],
  ['Microsoft.VisualStudio.Code.ExecutesCode', 'true'],
  ['Microsoft.VisualStudio.Services.Links.Source', 'https://github.com/shizuha-labs/shizuha.git'],
  ['Microsoft.VisualStudio.Services.Links.Getstarted', 'https://github.com/shizuha-labs/shizuha.git'],
  ['Microsoft.VisualStudio.Services.Links.GitHub', 'https://github.com/shizuha-labs/shizuha.git'],
  ['Microsoft.VisualStudio.Services.Links.Support', 'https://github.com/shizuha-labs/shizuha/issues'],
  ['Microsoft.VisualStudio.Services.Links.Learn', 'https://shizuha.com'],
  ['Microsoft.VisualStudio.Services.Branding.Color', '#4f46e5'],
  ['Microsoft.VisualStudio.Services.Branding.Theme', 'dark'],
  ['Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown', 'true'],
  ['Microsoft.VisualStudio.Services.Content.Pricing', 'Free'],
]);
exactJson([...propertyMap.entries()].sort(), [...expectedProperties.entries()].sort(), 'VSIX XML properties');

const installation = one(packageXml.Installation, 'Installation');
const targets = [].concat(installation.InstallationTarget || []);
if (targets.length !== 1 || targets[0]?.Id !== 'Microsoft.VisualStudio.Code' || Object.keys(targets[0]).some((key) => key !== 'Id')) {
  throw new Error('VSIX XML installation target is not the canonical platform-neutral VS Code target');
}
if (packageXml.Dependencies && Object.keys(packageXml.Dependencies).length > 0) throw new Error('VSIX XML dependencies are not authorized');
const assets = [].concat(one(packageXml.Assets, 'Assets').Asset || []);
const actualAssets = assets.map((asset) => [asset?.Type, asset?.Path, asset?.Addressable]).sort();
const expectedAssets = [
  ['Microsoft.VisualStudio.Code.Manifest', 'extension/package.json'],
  ['Microsoft.VisualStudio.Services.Content.Details', 'extension/readme.md'],
  ['Microsoft.VisualStudio.Services.Content.Changelog', 'extension/changelog.md'],
  ['Microsoft.VisualStudio.Services.Content.License', 'extension/LICENSE.txt'],
  ['Microsoft.VisualStudio.Services.Icons.Default', 'extension/images/icon.png'],
].map(([type, path]) => [type, path, 'true']).sort();
exactJson(actualAssets, expectedAssets, 'VSIX XML assets');
for (const doc of ['extension/readme.md', 'extension/changelog.md', 'extension/LICENSE.txt']) {
  if (!execFileSync('unzip', ['-p', vsix, doc]).length) throw new Error(`required document is empty: ${doc}`);
}

const packagedSha = execFileSync('unzip', ['-p', vsix, 'extension/SOURCE_SHA'], { encoding: 'utf8' }).trim();
if (packagedSha !== expectedSha) throw new Error('VSIX source SHA identity mismatch: ' + packagedSha);

const digest = createHash('sha256').update(readFileSync(vsix)).digest('hex');
console.log(JSON.stringify({
  artifact: 'shizuha-vscode.vsix',
  extension: manifest.publisher + '.' + manifest.name,
  version: manifest.version,
  source_sha: expectedSha,
  sha256: digest,
  files: listing.length,
}, null, 2));
