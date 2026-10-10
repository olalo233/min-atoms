"use client";

import { History, LoaderCircle } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export interface RestoreTarget {
  versionId: string;
  number: number;
  nextNumber: number;
}

interface RestoreDialogProps {
  target: RestoreTarget | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Restore confirmation (ux §7.5). Stays open on failure so the user can retry. */
export function RestoreDialog({ target, busy, error, onCancel, onConfirm }: RestoreDialogProps) {
  return (
    <AlertDialog open={target !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <span
            aria-hidden="true"
            className="mb-1 flex size-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 ring-1 ring-indigo-500/15"
          >
            <History className="size-5" />
          </span>
          <AlertDialogTitle>恢复到版本 {target?.number}？</AlertDialogTitle>
          <AlertDialogDescription>
            当前代码会回到版本 {target?.number} 的样子，应用里的数据不变。会生成新的版本 {target?.nextNumber}。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <Button type="button" onClick={onConfirm} disabled={busy} aria-busy={busy}>
            {busy && <LoaderCircle className="size-3.5 animate-spin" />}
            {busy ? "恢复中…" : "恢复"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
