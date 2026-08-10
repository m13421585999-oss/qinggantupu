# 完成一篇作品所需输入

## 本地声音分析

- 与朗诵逐字一致的完整正文。
- 单人、普通话清晰的 MP3、WAV 或 M4A 参考朗诵；尽量减少背景音乐、混响和削波。
- ElevenLabs API Key，保存在 `local-analyzer/.env`，不提交 Git、不粘贴到网站。

第一次在 Windows 双击 `local-analyzer/setup.bat` 完成安装与本地密钥配置。之后双击 `启动朗诵分析.bat` 即可使用。

## ChatGPT 解释

把本地工具生成的完整 `analysis-result.json` 交给 ChatGPT，要求返回：

- 原样保留全部 `tokens`、index、字符、拼音和时间戳；
- `sentences` 连续覆盖全部 token；
- 每句只加入 `focus`、`pauses`、`prolongations`、`prosody`、`ending_intonation`、`rhythm` 和 `confidence`；
- 不改写、删减或重新分词正文。

网站会再次校验这些约束。轻微的 Markdown 代码围栏和 JSON 尾逗号可以修复；正文或索引不一致会直接拒绝。

## 在线创作与 AI 示范

- 网站中填写作品名称、作者/来源和同一份完整正文。
- 导入 ChatGPT 返回的 `control_spec` JSON，再人工调整图谱。
- 如需在线生成 AI 示范，网站服务端需单独配置 ElevenLabs API Key 与 Voice ID。不要把本地 `.env` 上传到网站；托管 Secret 与本地分析配置是两套隔离配置。

第一版不需要 LLM API、Railway、Docker、云端 Python、多用户权限、用户录音、评分或陪练数据。
