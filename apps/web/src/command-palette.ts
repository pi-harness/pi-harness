const commandName = (button: HTMLButtonElement): string => button.firstChild?.textContent?.trim() ?? "";

export function installCommandPalette(root: HTMLElement): () => void {
  const palette = root.querySelector<HTMLElement>("[data-command-palette]");
  const input = root.querySelector<HTMLInputElement>("[data-command-input]");
  const prompt = root.querySelector<HTMLTextAreaElement>("[data-prompt]");
  const trigger = root.querySelector<HTMLElement>("[data-command]");
  const permission = root.querySelector<HTMLButtonElement>("[data-permission]");
  if (!palette || !input || !prompt) return () => {};
  const buttons = [...palette.querySelectorAll<HTMLButtonElement>(".palette-group button")];
  let activeIndex = 0;

  const visibleButtons = () => buttons.filter((button) => !button.hidden);
  const focusActive = () => {
    const visible = visibleButtons();
    if (visible.length === 0) return;
    activeIndex = Math.max(0, Math.min(activeIndex, visible.length - 1));
    visible.forEach((button, index) => button.classList.toggle("active", index === activeIndex));
  };
  const open = (query = "") => {
    palette.hidden = false;
    input.value = query;
    activeIndex = 0;
    filter();
    input.focus();
  };
  const close = () => {
    palette.hidden = true;
    input.value = "";
    buttons.forEach((button) => { button.hidden = false; button.classList.remove("active"); });
  };
  const filter = () => {
    const query = input.value.trim().toLowerCase();
    buttons.forEach((button) => { button.hidden = query.length > 0 && !button.textContent?.toLowerCase().includes(query); });
    focusActive();
  };
  const select = (button: HTMLButtonElement) => {
    const command = commandName(button);
    if (!command) return;
    prompt.value = command + " ";
    close();
    prompt.focus();
  };
  const onTrigger = () => open();
  const onInput = () => filter();
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { close(); return; }
    const visible = visibleButtons();
    if (event.key === "ArrowDown" && visible.length > 0) { event.preventDefault(); activeIndex = (activeIndex + 1) % visible.length; focusActive(); }
    if (event.key === "ArrowUp" && visible.length > 0) { event.preventDefault(); activeIndex = (activeIndex - 1 + visible.length) % visible.length; focusActive(); }
    if (event.key === "Enter" && visible.length > 0) { event.preventDefault(); select(visible[activeIndex]!); }
  };
  const onPromptInput = () => {
    const value = prompt.value;
    if (value.startsWith("/")) open(value.slice(1));
  };
  const onBackdrop = (event: MouseEvent) => { if (event.target === palette) close(); };
  const onCommandClick = (event: Event) => select(event.currentTarget as HTMLButtonElement);
  const onPermission = () => {
    const asking = permission?.getAttribute("aria-pressed") !== "true";
    if (permission) {
      permission.setAttribute("aria-pressed", String(asking));
      permission.textContent = asking ? "● 改动前询问" : "● 自动允许";
      permission.title = "权限策略仅在当前浏览器会话中保存";
    }
  };
  trigger?.addEventListener("click", onTrigger);
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeydown);
  prompt.addEventListener("input", onPromptInput);
  palette.addEventListener("click", onBackdrop);
  buttons.forEach((button) => button.addEventListener("click", onCommandClick));
  permission?.setAttribute("aria-pressed", "true");
  permission?.addEventListener("click", onPermission);
  return () => {
    trigger?.removeEventListener("click", onTrigger);
    input.removeEventListener("input", onInput);
    input.removeEventListener("keydown", onKeydown);
    prompt.removeEventListener("input", onPromptInput);
    palette.removeEventListener("click", onBackdrop);
    buttons.forEach((button) => button.removeEventListener("click", onCommandClick));
    permission?.removeEventListener("click", onPermission);
  };
}
