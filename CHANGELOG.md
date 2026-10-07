# 0.1.1

## 0.1.5 (2026-10-07)

- 缩小图标绘制内容约三分之一，增加方框内的留白。
- Reduce icon artwork by one third with a centered, padded viewBox.

## 0.1.4 (2026-10-07)

- 为插件列表提供中英文名称与说明，并发布独立的 SVG 图标。
- Publish English and Chinese plugin display metadata and a dedicated SVG icon.

## 0.1.3

- Align maintenance lockfiles and peer versions with the DSH 0.2 runtime.

## 0.1.2

- Update DSH compatibility requirements and interfaces for 0.2.1-alpha.1.

恢复迁移安装中的多账户兼容改动，支持旧版、版本 2 和多账户订阅存储，跳过停用账户。设置通过注入的 settings 服务注册。运行依赖使用发布版本，取消对原电脑源码目录的依赖。

验证：运行插件测试与打包预检；不包含真实订阅 API 调用验收。
