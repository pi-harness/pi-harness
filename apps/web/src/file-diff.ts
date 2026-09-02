async function readDiff(path: string): Promise<string> {
  const response = await fetch(`/api/files/diff?path=${encodeURIComponent(path)}`);
  const payload = (await response.json()) as { diff?: unknown; error?: unknown };
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `Diff request failed (${response.status})`);
  return typeof payload.diff === "string" && payload.diff.length > 0 ? payload.diff : "没有可显示的差异（可能是未跟踪文件或工作区已更新）。";
}

export function installFileDiff(root: HTMLElement): () => void {
  const host = root.querySelector<HTMLElement>("[data-files]");
  const details = root.querySelector<HTMLElement>("[data-details-panel]");
  const raw = root.querySelector<HTMLElement>(".raw-json");
  const title = root.querySelector<HTMLElement>("[data-detail-title]");
  if (!host || !details || !raw || !title) return () => {};
  const attach = () => {
    host.querySelectorAll<HTMLElement>(".file-row").forEach((row) => {
      if (row.querySelector("[data-file-diff]")) return;
      const path = row.querySelector("code")?.textContent?.trim();
      if (!path) return;
      const button = row.querySelector<HTMLButtonElement>("button") ?? document.createElement("button");
      button.type = "button";
      button.dataset.fileDiff = "true";
      button.textContent = "查看差异";
      button.addEventListener("click", () => {
        button.disabled = true;
        void readDiff(path)
          .then((diff) => {
            details.hidden = false;
            title.textContent = `文件差异 · ${path}`;
            raw.textContent = diff;
          })
          .catch((error: unknown) => {
            details.hidden = false;
            title.textContent = `文件差异 · ${path}`;
            raw.textContent = error instanceof Error ? error.message : String(error);
          })
          .finally(() => {
            button.disabled = false;
          });
      });
      if (!button.parentElement) row.append(button);
    });
  };
  const observer = new MutationObserver(attach);
  observer.observe(host, { childList: true, subtree: true });
  attach();
  return () => observer.disconnect();
}
