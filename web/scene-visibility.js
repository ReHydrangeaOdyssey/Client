function eventTriggers(models) {
  const hiddenBy = new Map();
  const shownBy = new Map();
  for (const model of models.values()) {
    if (model.kind !== "toggle button") continue;
    for (const event of model.data.events ?? []) {
      let triggers;
      if (event.type === "hide") triggers = hiddenBy;
      else if (event.type === "show_scroll_group") triggers = shownBy;
      else continue;
      const key = event.target ?? event.group;
      const sources = triggers.get(key) ?? [];
      sources.push(model);
      triggers.set(key, sources);
    }
  }
  return {hiddenBy, shownBy};
}

export function sceneVisibility({models, groups, overrides}) {
  const {hiddenBy, shownBy} = eventTriggers(models);
  const visible = new Map();
  const groupVisibility = new Map();
  const visiting = new Set();

  function active(model) {
    return model.on && isVisible(model.ref);
  }

  function groupVisible(name) {
    if (groupVisibility.has(name)) return groupVisibility.get(name);
    const key = "group:" + name;
    if (visiting.has(key)) throw new Error("Cyclic Scene visibility");
    visiting.add(key);
    const triggers = shownBy.get(name);
    const value = overrides.get(name) ?? (!triggers || triggers.some(active));
    visiting.delete(key);
    groupVisibility.set(name, value);
    return value;
  }

  function isVisible(reference) {
    if (visible.has(reference)) return visible.get(reference);
    if (visiting.has(reference)) throw new Error("Cyclic Scene visibility");
    visiting.add(reference);
    const model = models.get(reference);
    const value = (!model.parent || active(models.get(model.parent)))
      && !(hiddenBy.get(reference) ?? []).some(active)
      && (!model.group || groupVisible(model.group));
    visiting.delete(reference);
    visible.set(reference, value);
    return value;
  }

  for (const reference of models.keys()) isVisible(reference);
  for (const name of groups.keys()) groupVisible(name);
  return {visible, groupVisibility};
}
