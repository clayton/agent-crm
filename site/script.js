const copyButton = document.querySelector("[data-copy]");

copyButton?.addEventListener("click", async () => {
  const command = "git clone https://github.com/clayton/agent-crm.git";

  try {
    await navigator.clipboard.writeText(command);
    copyButton.textContent = "copied";
    window.setTimeout(() => {
      copyButton.textContent = "copy";
    }, 1800);
  } catch {
    copyButton.textContent = "select";
  }
});
