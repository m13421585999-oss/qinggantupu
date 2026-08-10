from __future__ import annotations

import json
import queue
import re
import threading
from datetime import datetime
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from analyzer import AnalyzerError, analyze_recitation, load_local_environment, save_analysis_result


APP_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = APP_DIR / "outputs"


class RecitationAnalyzerApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.audio_path: Path | None = None
        self.result: dict | None = None
        self.result_text = ""
        self.events: queue.Queue[tuple[str, object]] = queue.Queue()

        root.title("本地朗诵分析工具")
        root.geometry("880x720")
        root.minsize(720, 590)
        root.option_add("*Font", ("Microsoft YaHei UI", 10))

        self._build_ui()
        self.root.after(100, self._drain_events)

    def _build_ui(self) -> None:
        outer = ttk.Frame(self.root, padding=20)
        outer.pack(fill=tk.BOTH, expand=True)
        outer.columnconfigure(0, weight=1)

        ttk.Label(outer, text="本地朗诵分析工具", font=("Microsoft YaHei UI", 18, "bold")).grid(
            row=0, column=0, sticky="w"
        )
        ttk.Label(
            outer,
            text="正文和音频只在本机处理；音频会发送给 ElevenLabs 做强制对齐。结果只包含声音事实，不判断教学标签。",
            wraplength=820,
        ).grid(row=1, column=0, sticky="ew", pady=(6, 16))

        input_frame = ttk.LabelFrame(outer, text="1. 粘贴完整正文", padding=12)
        input_frame.grid(row=2, column=0, sticky="nsew")
        input_frame.columnconfigure(0, weight=1)
        self.text_input = tk.Text(input_frame, height=13, wrap=tk.WORD, undo=True)
        text_scrollbar = ttk.Scrollbar(input_frame, orient=tk.VERTICAL, command=self.text_input.yview)
        self.text_input.configure(yscrollcommand=text_scrollbar.set)
        self.text_input.grid(row=0, column=0, sticky="nsew")
        text_scrollbar.grid(row=0, column=1, sticky="ns")

        audio_frame = ttk.LabelFrame(outer, text="2. 选择参考朗诵", padding=12)
        audio_frame.grid(row=3, column=0, sticky="new", pady=(14, 0))
        audio_frame.columnconfigure(0, weight=1)
        self.audio_label = ttk.Label(audio_frame, text="尚未选择音频", foreground="#666666")
        self.audio_label.grid(row=0, column=0, sticky="w")
        self.choose_button = ttk.Button(audio_frame, text="选择 MP3 / WAV", command=self.choose_audio)
        self.choose_button.grid(row=0, column=1, padx=(12, 0))

        action_frame = ttk.Frame(outer)
        action_frame.grid(row=4, column=0, sticky="ew", pady=(16, 0))
        action_frame.columnconfigure(1, weight=1)
        self.start_button = ttk.Button(action_frame, text="开始分析", command=self.start_analysis)
        self.start_button.grid(row=0, column=0, sticky="w")
        self.progress = ttk.Progressbar(action_frame, mode="indeterminate", length=160)
        self.progress.grid(row=0, column=1, sticky="w", padx=(14, 0))
        self.status_label = ttk.Label(action_frame, text="等待输入")
        self.status_label.grid(row=0, column=2, sticky="e")

        result_frame = ttk.LabelFrame(outer, text="3. 分析结果", padding=12)
        result_frame.grid(row=5, column=0, sticky="nsew", pady=(14, 0))
        result_frame.columnconfigure(0, weight=1)
        result_frame.rowconfigure(0, weight=1)
        outer.rowconfigure(5, weight=1)
        self.preview = tk.Text(result_frame, height=10, wrap=tk.NONE, state=tk.DISABLED)
        preview_y = ttk.Scrollbar(result_frame, orient=tk.VERTICAL, command=self.preview.yview)
        preview_x = ttk.Scrollbar(result_frame, orient=tk.HORIZONTAL, command=self.preview.xview)
        self.preview.configure(yscrollcommand=preview_y.set, xscrollcommand=preview_x.set)
        self.preview.grid(row=0, column=0, sticky="nsew")
        preview_y.grid(row=0, column=1, sticky="ns")
        preview_x.grid(row=1, column=0, sticky="ew")

        result_actions = ttk.Frame(result_frame)
        result_actions.grid(row=2, column=0, sticky="ew", pady=(10, 0))
        self.copy_button = ttk.Button(
            result_actions, text="复制分析结果", command=self.copy_result, state=tk.DISABLED
        )
        self.copy_button.pack(side=tk.LEFT)
        self.download_button = ttk.Button(
            result_actions, text="下载 JSON", command=self.download_result, state=tk.DISABLED
        )
        self.download_button.pack(side=tk.LEFT, padx=(10, 0))

    def choose_audio(self) -> None:
        selected = filedialog.askopenfilename(
            title="选择参考朗诵音频",
            filetypes=[
                ("音频文件", "*.mp3 *.wav *.m4a *.aac *.flac *.ogg"),
                ("所有文件", "*.*"),
            ],
        )
        if not selected:
            return
        self.audio_path = Path(selected)
        size_mb = self.audio_path.stat().st_size / (1024 * 1024)
        self.audio_label.configure(text=f"{self.audio_path.name}（{size_mb:.1f} MB）", foreground="#222222")

    def start_analysis(self) -> None:
        full_text = self.text_input.get("1.0", "end-1c")
        if not full_text.strip():
            messagebox.showwarning("缺少正文", "请先粘贴完整正文。")
            return
        if self.audio_path is None:
            messagebox.showwarning("缺少音频", "请先选择参考朗诵 MP3 或 WAV。")
            return

        self.result = None
        self.result_text = ""
        self.copy_button.configure(state=tk.DISABLED)
        self.download_button.configure(state=tk.DISABLED)
        self.start_button.configure(state=tk.DISABLED)
        self.choose_button.configure(state=tk.DISABLED)
        self.status_label.configure(text="正在对齐并分析，请稍候…")
        self.progress.start(12)
        self._set_preview("正在执行 ElevenLabs Forced Alignment，然后进行本地 Parselmouth 声学分析。\n请不要关闭窗口。")

        thread = threading.Thread(
            target=self._analysis_worker,
            args=(full_text, self.audio_path),
            daemon=True,
        )
        thread.start()

    def _analysis_worker(self, full_text: str, audio_path: Path) -> None:
        try:
            result = analyze_recitation(full_text=full_text, audio_path=audio_path)
            saved_path = self._automatic_output_path(audio_path)
            save_analysis_result(result, saved_path)
            self.events.put(("success", (result, saved_path)))
        except AnalyzerError as exc:
            self.events.put(("error", str(exc)))
        except Exception as exc:  # noqa: BLE001 - keep GUI alive and report unexpected failures.
            self.events.put(("error", f"发生未预期错误：{exc}"))

    def _automatic_output_path(self, audio_path: Path) -> Path:
        safe_stem = re.sub(r"[^\w\-\u3400-\u9fff]+", "-", audio_path.stem).strip("-") or "recitation"
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        return OUTPUT_DIR / f"{safe_stem}-{timestamp}-analysis-result.json"

    def _drain_events(self) -> None:
        try:
            while True:
                event, payload = self.events.get_nowait()
                if event == "success":
                    result, saved_path = payload
                    self._finish_success(result, saved_path)
                elif event == "error":
                    self._finish_error(str(payload))
        except queue.Empty:
            pass
        self.root.after(100, self._drain_events)

    def _finish_success(self, result: dict, saved_path: Path) -> None:
        self.progress.stop()
        self.start_button.configure(state=tk.NORMAL)
        self.choose_button.configure(state=tk.NORMAL)
        self.copy_button.configure(state=tk.NORMAL)
        self.download_button.configure(state=tk.NORMAL)
        self.result = result
        self.result_text = json.dumps(result, ensure_ascii=False, indent=2)
        token_count = len(result.get("tokens", []))
        self.status_label.configure(text=f"分析完成 · {token_count} 个字符")
        self._set_preview(self.result_text)
        messagebox.showinfo(
            "分析完成",
            f"分析结果已自动保存到：\n{saved_path}\n\n现在可以复制结果发送给 ChatGPT。",
        )

    def _finish_error(self, message: str) -> None:
        self.progress.stop()
        self.start_button.configure(state=tk.NORMAL)
        self.choose_button.configure(state=tk.NORMAL)
        self.status_label.configure(text="分析失败")
        self._set_preview(f"分析失败\n\n{message}")
        messagebox.showerror("分析失败", message)

    def _set_preview(self, content: str) -> None:
        self.preview.configure(state=tk.NORMAL)
        self.preview.delete("1.0", tk.END)
        self.preview.insert("1.0", content)
        self.preview.configure(state=tk.DISABLED)

    def copy_result(self) -> None:
        if not self.result_text:
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(self.result_text)
        self.root.update_idletasks()
        self.status_label.configure(text="已复制，可直接粘贴给 ChatGPT")

    def download_result(self) -> None:
        if self.result is None:
            return
        target = filedialog.asksaveasfilename(
            title="保存分析结果",
            defaultextension=".json",
            initialfile="analysis-result.json",
            filetypes=[("JSON 文件", "*.json")],
        )
        if not target:
            return
        save_analysis_result(self.result, target)
        self.status_label.configure(text="JSON 已保存")


def main() -> None:
    load_local_environment(APP_DIR)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    root = tk.Tk()
    RecitationAnalyzerApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
