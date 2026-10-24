import type { ReactNode } from "react";
import { useState } from "react";
import { create } from "zustand";

import { IconX } from "./icons";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}

export function Modal({ title, onClose, children, width }: ModalProps) {
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" style={width ? { width } : undefined}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <IconX size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

interface Question {
  id: number;
  title: string;
  message: string;
  input?: boolean;
  value?: string;
  resolve: (value: string | boolean | null) => void;
}
const useQuestions = create<{ queue: Question[] }>(() => ({ queue: [] }));
let nextId = 0;
function ask(opts: Omit<Question, "resolve" | "id">, signal?: AbortSignal) {
  return new Promise<string | boolean | null>((resolve) => {
    if (signal?.aborted || useQuestions.getState().queue.length >= 16) {
      resolve(null);
      return;
    }
    const id = ++nextId;
    const abort = () => finish(null);
    const finish = (value: string | boolean | null) => {
      signal?.removeEventListener("abort", abort);
      useQuestions.setState((s) => ({
        queue: s.queue.filter((q) => q.id !== id),
      }));
      resolve(value);
    };
    signal?.addEventListener("abort", abort, { once: true });
    useQuestions.setState((s) => ({
      queue: [...s.queue, { ...opts, id, resolve: finish }],
    }));
  });
}
export async function confirm(
  opts: { title: string; message: string },
  signal?: AbortSignal,
): Promise<boolean> {
  return (await ask(opts, signal)) === true;
}
export async function promptText(
  title: string,
  value = "",
): Promise<string | null> {
  const v = await ask({ title, message: "", input: true, value });
  return typeof v === "string" ? v : null;
}
export function Dialogs() {
  const q = useQuestions((s) => s.queue[0]);
  return q ? <QuestionDialog key={q.id} question={q} /> : null;
}
function QuestionDialog({ question: q }: { question: Question }) {
  const [value, setValue] = useState(q.value ?? "");
  const done = (result: string | boolean | null) => q.resolve(result);
  return (
    <Modal title={q.title} onClose={() => done(null)} width={520}>
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {q.message}
      </p>
      {q.input && (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") done(value);
          }}
        />
      )}
      <div className="form-actions">
        <button className="btn" onClick={() => done(null)}>
          取消
        </button>
        <button
          className="btn primary"
          onClick={() => done(q.input ? value : true)}
        >
          确认
        </button>
      </div>
    </Modal>
  );
}
