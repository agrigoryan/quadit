// Short messages that appear at the bottom of the screen. This file holds
// the list; ui/toast.tsx draws it.

import { create } from "zustand";
import { newId } from "@/lib/ids";

export interface ToastItem {
  id: string;
  kind: "info" | "error";
  text: string;
  action?: { label: string; run: () => void };
}

export const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));

function show(kind: ToastItem["kind"], text: string, action?: ToastItem["action"]) {
  const item: ToastItem = { id: newId(), kind, text, action };
  useToasts.setState((s) => ({ items: [...s.items.slice(-3), item] }));
}

export const toast = {
  info: (text: string, action?: ToastItem["action"]) => show("info", text, action),
  error: (text: string, action?: ToastItem["action"]) => show("error", text, action),
  dismiss: (id: string) => useToasts.setState((s) => ({ items: s.items.filter((i) => i.id !== id) })),
};
