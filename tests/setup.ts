import { registerNodeSha256 } from "../src/core/hash-node.js";
import { registerNodeHost } from "../src/host/node-host.js";

// 测试运行在 Node 环境，先注册 Node 版 SHA-256 与宿主实现。
registerNodeSha256();
registerNodeHost();