"use client";

import { useI18n } from "@/hooks/useI18n";
import { useProjectFilterMode } from "@/lib/project-filter";
import { setWorktreeFilterMode, useWorktreeFilterMode } from "@/lib/worktree-filter";

/**
 * Settings › General's Worktree filter row, under the project filter: the
 * current project's sessions, all of them or the worktree in use only.
 *
 * The row appears with the project filter's scope: narrowing to the worktree
 * in use needs the current project, so without it there is nothing to
 * narrow and the row is not offered at all.
 */
export function WorktreeFilterSetting() {
  const { t } = useI18n();
  const projectFilter = useProjectFilterMode();
  const worktreeFilter = useWorktreeFilterMode();
  if (projectFilter !== "on") return null;
  return (
    <div className="settings-chat-option settings-chat-switch-option" role="radiogroup" aria-label={t("settings.worktreeFilter")}>
      <span>{t("settings.worktreeFilter")}</span>
      <div className="settings-send-mode-options">
        <label className="settings-send-mode-option">
          <input
            type="radio"
            name="worktree-filter"
            value="off"
            checked={worktreeFilter === "off"}
            onChange={() => setWorktreeFilterMode("off")}
            className="sr-only"
          />
          <span className="settings-send-mode-label">{t("sidebar.worktreeAllSessions")}</span>
        </label>
        <label className="settings-send-mode-option">
          <input
            type="radio"
            name="worktree-filter"
            value="on"
            checked={worktreeFilter === "on"}
            onChange={() => setWorktreeFilterMode("on")}
            className="sr-only"
          />
          <span className="settings-send-mode-label">{t("sidebar.worktreeCurrent")}</span>
        </label>
      </div>
    </div>
  );
}
