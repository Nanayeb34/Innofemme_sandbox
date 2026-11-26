"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { basicSetup } from "codemirror";
import { indentWithTab, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { indentUnit } from "@codemirror/language";
import { openSearchPanel } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";

/**
 * A real code editor (CodeMirror): colours for JavaScript and Python, line numbers, undo and redo, find and
 * replace, bracket matching, automatic indentation, code folding. Mod-S saves.
 */

export interface CodeEditorHandle {
  undo: () => void;
  redo: () => void;
  find: () => void;
  focus: () => void;
}

export interface EditorInfo {
  line: number;
  column: number;
  lines: number;
  canUndo: boolean;
  canRedo: boolean;
}

interface Props {
  /** The text the editor opens with. Later changes to it are ignored: the editor owns its text once open. */
  initial: string;
  language: "javascript" | "python";
  onChange?: (text: string) => void;
  onSave?: () => void;
  onInfo?: (info: EditorInfo) => void;
}

const look = EditorView.theme(
  {
    "&": { height: "100%", fontSize: "var(--code-size, 13px)" },
    ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", lineHeight: "1.65" },
    ".cm-content": { padding: "12px 0" },
    ".cm-gutters": { borderRight: "1px solid #3a3f4b" },
    ".cm-panels input, .cm-panels button": { fontSize: "12px" },
    ".cm-tooltip": { borderRadius: "8px", overflow: "hidden" },
  },
  { dark: true },
);

export const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor({ initial, language, onChange, onSave, onInfo }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The latest callbacks, so the editor (made once) always calls the current ones.
  const calls = useRef({ onChange, onSave, onInfo });
  useEffect(() => {
    calls.current = { onChange, onSave, onInfo };
  });

  useEffect(() => {
    const report = (state: EditorState) => {
      const pos = state.selection.main.head;
      const line = state.doc.lineAt(pos);
      calls.current.onInfo?.({ line: line.number, column: pos - line.from + 1, lines: state.doc.lines, canUndo: undoDepth(state) > 0, canRedo: redoDepth(state) > 0 });
    };
    const state = EditorState.create({
      doc: initial,
      extensions: [
        basicSetup,
        language === "python" ? python() : javascript(),
        indentUnit.of(language === "python" ? "    " : "  "),
        EditorState.tabSize.of(language === "python" ? 4 : 2),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              calls.current.onSave?.();
              return true;
            },
          },
          indentWithTab,
        ]),
        oneDark,
        look,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) calls.current.onChange?.(u.state.doc.toString());
          if (u.docChanged || u.selectionSet) report(u.state);
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    report(state);
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is made once per file; the parent gives it a new key to open another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    undo: () => view.current && undo(view.current),
    redo: () => view.current && redo(view.current),
    find: () => view.current && openSearchPanel(view.current),
    focus: () => view.current?.focus(),
  }));

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
});
