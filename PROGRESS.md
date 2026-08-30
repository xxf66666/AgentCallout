# AgentCallout 进度

最后更新：2026-08-30（Asia/Singapore）

## 当前状态

- 阶段：仓库与环境审计、官方能力调研、技术验证
- GitHub：`https://github.com/xxf66666/AgentCallout`（公开空仓库，当前账号具有管理员权限）
- 本地分支：`main`
- 阻塞：无

## 已完成

- [x] 读取并接受项目目标与完成定义
- [x] 检查本地 Git 仓库、CodeGraph 索引和工作区状态
- [x] 确认远程仓库为空且未设置默认分支
- [x] 将本地仓库连接到正式 GitHub 远程
- [x] 确认本机安装 Node.js、npm、pnpm、Git、GitHub CLI、Claude Code 和 Codex CLI
- [x] 启动 Claude Code、Codex、MCP 与竞品的并行证据调研

## 进行中

- [ ] 形成 `docs/research.md` 的有边界调研结论
- [ ] 对候选渲染技术完成中文、箭头、文字框和隐私遮挡实验
- [ ] 确定最少步骤的 Claude Code 与 Codex GitHub 安装路径

## 待完成

- [ ] 架构、兼容性、安全和路线图文档
- [ ] AnnotationSpec 与验证器
- [ ] 图片检查、裁剪、批注渲染和自动排版
- [ ] CLI 与本地 stdio MCP Server
- [ ] Claude Code 与 Codex Skill/Plugin 包装
- [ ] 安装、升级、卸载、dry-run、备份与 doctor/self-test
- [ ] 单元、集成、像素安全、确定性和安装测试
- [ ] `ui-bug`、`numbered-review`、`privacy` 三组真实生成示例
- [ ] Claude Code 和 Codex 实际调用及一次二次修正
- [ ] 干净克隆验收
- [ ] Git 里程碑提交和 GitHub 推送

## 验证日志

| 时间 | 检查 | 结果 |
| --- | --- | --- |
| 2026-08-30 | `gh repo view xxf66666/AgentCallout` | 仓库存在、公开、空仓库、管理员权限 |
| 2026-08-30 | 本机工具链 | Node `v24.18.1`、npm `11.16.0`、pnpm `11.19.0`、Claude Code `2.1.251`、Codex CLI `0.151.0` |

