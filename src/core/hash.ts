export type Sha256Fn = (input: string) => string;

let current: Sha256Fn | undefined;

/**
 * 注册全局 SHA-256 实现。
 * Node 侧调用 registerNodeSha256()（hash-node.ts），WebView 侧调用 registerWebSha256()（hash-web.ts）。
 * 具体实现的选择必须发生在首次使用 sha256() 之前。
 */
export function setSha256(implementation: Sha256Fn): void {
  current = implementation;
}

export function sha256(input: string): string {
  if (!current) {
    throw new Error(
      "sha256 implementation is not registered. Call setSha256() (registerNodeSha256 / registerWebSha256) at startup."
    );
  }
  return current(input);
}