# dsh-gpt-web-search

让稳定的 web_search 工具改由 GPT 订阅模型执行联网检索。

## 安装

锁定公开仓库的提交后，通过 DSH 官方入口安装：

```powershell
pnpm dsh plugin --profile web add github:vb2250158/dsh-gpt-web-search#<commit>
```

插件包声明 `dsh.bundle`，安装后会把自己的配置层加入 profile。

## 配置

插件配置保存在 DSH profile 的 `cordis.patch.yml`。多电脑同步仓库只保存仓库地址、固定提交、启停状态和配置，不保存本仓库源码。

订阅登录来自本机 Subscriptions 登录存储。支持旧版单账户、版本 2 账户列表和多账户存储；选择启用的默认账户，默认账户不可用时按账户顺序选择。登录凭据不保存在插件仓库中。

## 验证

```powershell
npm test
npm pack --dry-run
```

## 许可证

MIT
