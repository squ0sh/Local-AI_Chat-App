// Single source of truth for the portable runtime download pins. Used by
// tools/package-runtimes.mjs (bundling) and tools/write-downloads.mjs (the
// launcher's runtime/downloads.txt restore table).
export const NODE_VERSION = '26.8.1';
export const OLLAMA_VERSION = '0.33.3';

export const nodeArtifacts = {
  'linux-x64': ['node-v26.8.1-linux-x64.tar.xz', '3e301118d7df53d563b7e96c1617545f26e2f76f9724be668d6cab65c15dda5d'],
  'linux-arm64': ['node-v26.8.1-linux-arm64.tar.xz', '23c1b4d19e2f12a7d06fe8aa3d6e0e4923cf77a47e13c5ccdf32fadaa33960f2'],
  'darwin-x64': ['node-v26.8.1-darwin-x64.tar.xz', '977c742754a1fa2425d3d9b4a17ca0ba4809919030432f47880b3dba8260cb6f'],
  'darwin-arm64': ['node-v26.8.1-darwin-arm64.tar.xz', 'b32047d86467497d3f59b8cf81f422c06938cf5f36ece2b36f6e7c024a0a3e5b'],
  'win32-x64': ['win-x64/node.exe', '5cba0ea928508c65ddadefc0681d2fb6d95f1f3beea4428f04397631140ee8e5'],
  'win32-arm64': ['win-arm64/node.exe', '8f359458741eaccce126ce45b1754e164b28849d05f7dfc2fdd1567054f47afc'],
};

export const ollamaArtifacts = {
  'linux-x64': ['ollama-linux-amd64.tar.zst', 'c13cea8f3389db4145f8a6cb88d1747242a48639d7c13e3bda7c1ebdc6eebb2f'],
  'linux-arm64': ['ollama-linux-arm64.tar.zst', '4425a112af999ae6572c1ce211fbabeaca7bab23ed5860972acdfc0cc2358420'],
  'win32-x64': ['ollama-windows-amd64.zip', '52cb36a62e7e501f61514f60212dec7117b6c098811357585e02fffe32d2fcd7'],
  'win32-arm64': ['ollama-windows-arm64.zip', '98b9ddaab6baece0418c6d1231526eb1e4e66944985e0a8eeb7d6171bcd7b6d8'],
  darwin: ['ollama-darwin.tgz', '342db03df80bb9db84ff64246031bd5f70c09b59ff52fa5cc9aaae3476cc4a9d'],
};

export function nodeArchiveUrl(artifact) {
  return `https://nodejs.org/dist/v${NODE_VERSION}/${artifact}`;
}

export function ollamaArchiveUrl(artifact) {
  return `https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/${artifact}`;
}