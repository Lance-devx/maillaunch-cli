export function renderTemplate(template, data) {
  return template.replace(/(?<!\{)\{\{([^{}]+)\}\}(?!\})/g, (_, key) => {
    const value = data[key.trim()];
    return value == null ? '' : String(value);
  });
}
