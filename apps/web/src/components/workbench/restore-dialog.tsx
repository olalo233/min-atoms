"use client";

import { LoaderCircle } from "lucide-react";

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
          <AlertDialogTitle>恢复到版本 {target?.number}？</AlertDialogTitle>
          <AlertDialogDescription>
            当前代码会回到版本 {target?.number} 的样子，应用里的数据不变。会生成新的版本 {target?.nextNumber}。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <Button type="button" onClick={onConfirm} disabled={busy} className="rounded-xl bg-indigo-600 text-white hover:bg-indigo-600/90">
            {busy && <LoaderCircle className="size-3.5 animate-spin" />}
            恢复
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
