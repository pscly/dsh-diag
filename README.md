# dsh-diag（命令：`dshcc`）

**DeepSeek Harness Companion CLI** — 只读的环境诊断工具：看 profile、看插件、查引擎兼容、查凭据权限。

> 非官方，不属于 DeepSeek Harness 项目。配套 [dsh-sub2api](https://github.com/pscly/dsh-sub2api) 使用。

## 为什么需要它

DSH 出问题时，第一件事往往是问「你装了什么、装在哪、版本对不对」。这些信息散在 `$DSH_HOME/profiles/*/package.json`、`cordis.patch.yml` 和各插件的 `package.json` 里，手工翻很慢。`dshcc` 一次列出来。

而且它**只读**：不写文件、不改配置、不装依赖。

## 安装

```sh
npx dsh-diag --help
# 或
npm i -g dsh-diag
```

零依赖，Node 18 以上。

## 命令

```sh
# 有哪些 profile 和各装了多少插件
dshcc profiles

# 某个 profile 装了哪些插件（带 bundle / client 标记）
dshcc plugins --profile web

# 全面体检
dshcc doctor
```

`doctor` 输出示例：

```
dshcc 0.1.0  节点 v24.22.1

  ✓ DSH_HOME   /root/.dsh
  ✓ profiles   headless、web
  ✓ 引擎版本    0.2.2-rc.1
  ✓ 凭据文件权限  /root/.dsh/.credentials.yaml 600

没有发现问题。
```

## doctor 检查什么

| 检查 | 说明 |
|---|---|
| `DSH_HOME` | 目录是否存在 |
| `profiles` | 至少有一个带 `package.json` 的 profile |
| 引擎版本 | 先看 profile 的 `node_modules`，没有就问 `dsh --version` |
| 凭据文件权限 | `.credentials.yaml` 必须是 `600`，否则给出 `chmod` 提示 |
| 插件兼容性 | 插件的 `engines.dsh` / `dsh.compatibility.dsh` 是否覆盖当前引擎 |

最后一项最有用：插件升级跟不上引擎时会静默失灵，`doctor` 会点名是哪个插件、声明了什么范围、当前是什么版本。

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | 覆盖 DSH 主目录，默认 `~/.dsh` |

## 已知限制

- 兼容性判断只支持 `>=` `<=` `>` `<` `=` `^` `~` 和 `||`，这是 DSH 插件实际会写的形式；不处理 `x`/`*` 通配。
- 引擎版本号内的 prerelease（如 `0.2.2-rc.1`）按 semver 规则低于同版本正式版。

## 许可证

MIT

## 关于包名

命令叫 `dshcc`，但 npm 上的包名是 `dsh-diag`：`dshcc` 与已存在的 `dsh-cc` 被 npm 判定为相似名，无法注册。安装后两个命令都可用（`dshcc` 与 `dsh-diag`）。
