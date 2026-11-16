import { exposeToWindow, runWebCollection } from "./main.js";

// bundle/collector.js 入口：注册全局采集函数，供 frontend/index.html 直接调用。
exposeToWindow();

// 类型收口，避免打包器把入口函数标记为未使用。
void runWebCollection;