# 朗诵表达分析规则 v1.0

## 总体目标

依据当前作品的准确正文、Forced Alignment 时间轴和客观声学证据，生成约 80% 以上感知合理、可由创作者快速修正的朗诵控制谱初稿。不得改变正文，不得套用其他作品，不确定时降低置信度。

## 分析职责

声学层先确定并保存字符时间轴、真实停顿、相对时值、句尾音高走向和连续 `macro_prosody_path`。这些声音事实不得由语言模型改写。语言模型只解释文本逻辑、表达焦点、节奏，以及连续声音路径可能具有的教学意义。

任何教学标签都可以为空。证据不足时不标，不能为了填满字段而制造标签。

## 重音 focus

重音是表达焦点，不等同于声音更大。先结合语法关系、上下文逻辑和情感表达寻找候选，再确认参考朗诵是否通过音量、时值、音高、速度、音色、声音虚实或前后反差形成主次。重音应少而精。

语言模型只输出 `focus_span`：教学上应该整体标红的词或词组。系统再根据真实时值、能量与音高证据，在该区间内计算 `focus_core`。图谱显示 `focus_span`，`focus_core` 只保留在内部数据中。

## 停顿 pauses

短停为 `short`（前端显示 `/`），长停为 `long`（前端显示 `///`）。标点仅作参考，实际声音间隔、意群结构、语义关系及当前整体语速优先。底层保留 `observed_gap_ms`，分类使用相对尺度。停顿由声学层直接生成，语言模型不重复判断。

## 拖音 prolongations

拖音是某个字或音节相对于当前局部朗诵语速明显延长，主要依据 `local_duration_ratio`，不得使用适用于所有作品的固定毫秒阈值。拖音与句尾语调可以同时存在。拖音由声学层直接生成，语言模型不重复判断。

## 语势 prosody

只允许四种：

- `peak`：表达张力、音高或能量在区间中部整体扩张，随后释放（波峰）
- `valley`：表达张力在区间中部整体下沉、收束或放缓，随后恢复（波谷）
- `rising`：逐渐抬升和推进（起潮）
- `falling`：逐渐下降和收束（落潮）

Parselmouth 先生成由 `level`、`rising`、`falling` 连续片段构成的 `macro_prosody_path`。相邻片段共享同一边界高度，不能先选教学类型再套固定曲线。

语言模型只负责把真实连续路径解释成教学意义上的语势事件。语势是连续文字区间的宏观声音运动，不是整句模板。每个事件必须包含 `active_span`、`core_zone`、`strength`、`confidence`。一句可以没有事件，也可以包含多个连续事件。允许前平、局部变化、后平。区间大致正确即可，不追求峰谷精确到单字。

判断语势必须综合平滑音高、相对能量、局部时值、语速、停连、前后反差和文本表达。`macro_pitch_contour` 只是证据之一，不能单独决定类型。单个字的高低 F0、普通话字调、清音或无声字造成的缺失值，都不能直接视为句级波峰或波谷。

当区间中部出现明显弱化、放缓、延长、留白或情绪收束，并在后半区重新展开时，可以判为 `valley`，即使其中个别音节因普通话字调呈现较高 F0。`peak` 则应有区间级的整体扩张或张力抬升，不能只依据一个高音字。跨越意群停顿的同一表达运动可以保留为一个 `active_span`。

当 `macro_pitch_contour` 与 `macro_energy_contour`、`macro_duration_contour` 的连续趋势冲突时，先检查音高是否由少量极值、字调或无声区间造成。若能量与时值共同呈现稳定的下沉—恢复或扩张—释放，应优先采用这组相互印证的宏观证据，并相应降低置信度，而不是让孤立 F0 决定类型。

## 句尾语调 ending_intonation

只允许 `rising`、`falling`、`level`，分别对应 ↗、↘、→。它描述句尾最后若干有效音节的整体方向，与整句语势相互独立。句尾语调优先由最后有效音节及最后意群的真实 F0 运动直接确定，语言模型不重复判断；尤其不能在摘要过程中丢失末尾真实上扬。

## 节奏 rhythm

只允许：

- `light` 轻快
- `solemn` 凝重
- `relaxed` 舒缓
- `tense` 紧张
- `soaring` 高亢
- `low` 低沉

节奏不是语速的同义词。综合语速、停连、声音轻重、音高变化、连贯程度、语言张弛、文本内容和上下文判断。

## 隐藏表演参数 performance_profile

控制谱可额外保存只供 AI 示范使用的隐藏表演参数，不在图谱主界面展示：

- `delivery_mode`：`natural_narration`、`lyrical_recitation`、`stage_recitation`
- `emotion_tone`：少量简短的情绪底色词
- `continuity`：`connected`、`balanced`、`segmented`
- `voice_quality`：`neutral`、`solid`、`slightly_breathy`、`breathy`、`mixed`，以及 `breathy_to_supported`、`breathy_to_mixed`、`mixed_to_solid`、`solid_to_soft`
- `focus_style`：`supported`、`soft`、`slower`、`lower_weighted`、`breathy`、`breathy_to_supported`
- `expression_amplitude`：`low`、`medium`、`high`
- `avoid`：本句或全篇需要避免的声音倾向

全篇 `performance_profile` 负责稳定的宏观表演状态。句级 profile 只在节奏、情绪、质感或表达幅度确有明显变化时给出，不要逐句重复同一状态，也不要为了填字段强行输出。`focus_style` 说明表达焦点的实现倾向，重音仍不等于增大音量。

## 输出纪律

只解释证据，不测量或编造声音事实。所有 token index 必须引用当前句范围。语势的 `core_zone` 必须位于 `active_span` 内。不得重新输出或覆盖停顿、拖音、句尾语调和基础声音路径。不得输出教师口令、句首/句尾声音、复杂声学参数或分析过程。
