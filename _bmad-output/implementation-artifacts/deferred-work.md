- source_spec: `D:\Project\github\AgentCallout\_bmad-output\implementation-artifacts\spec-readable-annotation-defaults.md`
  summary: 单独实现 numbered-callout 的 marker/target/label 几何分离与最短可见引线。
  evidence: 引线几何可独立开发和验收；从样式 Schema 拆出可降低当前 spec 上下文风险，并保持按顺序迭代。
- source_spec: `D:\Project\github\AgentCallout\_bmad-output\implementation-artifacts\spec-readable-annotation-defaults.md`
  summary: 在完整 v0.1.3 发布整合时统一升级 package、Plugin、Skill、renderer 和构建产物版本并增加版本一致性门禁。
  evidence: 当前仅完成可独立审查的样式子故事；提前升版会让后续引线、修订和可靠性改动失去同一发布里程碑。
- source_spec: `D:\Project\github\AgentCallout\_bmad-output\implementation-artifacts\spec-visible-numbered-callout-leaders.md`
  summary: 在完整 v0.1.3 发布整合时升级 renderer/package 身份，并记录预发布 1.1 numbered geometry 的重放边界。
  evidence: 本故事改变了 1.1 自动几何但按批准范围不提前升版；发布前必须让 sidecar renderer 身份能区分旧新像素语义。
