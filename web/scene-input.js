export class SceneInput {
  constructor(view) {
    this.view = view;
    this.canvas = view.renderer.canvas;
    this.pointer = null;
    this.listeners = new Map();
    this.listen("pointerdown", event => this.press(event));
    this.listen("pointermove", event => this.move(event));
    this.listen("pointerup", event => this.release(event));
    this.listen("wheel", event => this.wheel(event));
    for (const type of ["pointercancel", "lostpointercapture"]) {
      this.listen(type, event => {
        if (this.pointer?.id === event.pointerId) this.cancel();
      });
    }
  }

  listen(type, handler) {
    this.canvas.addEventListener(type, handler);
    this.listeners.set(type, handler);
  }

  press(event) {
    const view = this.view;
    if (view.loading || view.toggleBusy || this.pointer
        || event.button !== 0 || view.renderer.lost) return;
    view.audio?.unlock().catch(error => view.onError(error.message));
    const hits = view.renderer.nodes.filter(node =>
      node.interactive && view.renderer.hit(node, event.clientX, event.clientY));
    if (hits.length !== 1) return;
    this.pointer = {id: event.pointerId, ref: hits[0].ref, state: view.current};
    this.canvas.setPointerCapture(event.pointerId);
    view.refresh();
  }

  isInside(event) {
    const renderer = this.view.renderer;
    const node = renderer.nodes.find(node => node.ref === this.pointer?.ref);
    return node?.interactive && renderer.hit(node, event.clientX, event.clientY);
  }

  move(event) {
    if (this.pointer?.id !== event.pointerId) return;
    if (!this.isInside(event)) this.cancel();
  }

  release(event) {
    const pointer = this.pointer;
    if (pointer?.id !== event.pointerId) return;
    const view = this.view;
    const valid = !view.loading && !view.toggleBusy && !view.renderer.lost
      && pointer.state === view.current && this.isInside(event);
    this.cancel();
    if (!valid) return;
    const model = view.current.models.get(pointer.ref);
    const activationId = ++view.sequence;
    if (model.data.se) view.playAudio(view.current, "se." + model.data.se, "se");
    const action = model.kind === "toggle button"
      ? view.toggle(pointer.ref) : view.activate?.(pointer.ref, activationId);
    Promise.resolve(action)
      .then(result => { if (result && !result.ok) view.onError(result.error); })
      .catch(error => view.onError(error.message));
  }

  wheel(event) {
    const view = this.view;
    if (view.loading || !view.current || !view.renderer.view || event.deltaMode !== 0) return;
    const viewport = view.renderer.view;
    const rect = this.canvas.getBoundingClientRect();
    // Invert the viewport: scene x=(client x-left-cx)/scale, y=(cy-client y+top)/scale.
    const x = (event.clientX - rect.left - viewport.cx) / viewport.scale;
    const y = (viewport.cy - event.clientY + rect.top) / viewport.scale;
    const groups = [...view.current.groups.entries()].filter(([name, group]) =>
      view.current.groupVisibility.get(name)
      && Math.abs(x - group.px) <= group.width / 2
      && Math.abs(y - group.py) <= group.height / 2);
    if (groups.length !== 1) return;
    const [name, group] = groups[0];
    // Scroll displacement in scene coordinates = wheel displacement / viewport scale.
    view.scroll(name, group.x + event.deltaX / viewport.scale,
      group.y + event.deltaY / viewport.scale);
    event.preventDefault();
  }

  cancel() {
    const pointer = this.pointer;
    this.pointer = null;
    if (pointer && this.canvas.hasPointerCapture(pointer.id)) {
      this.canvas.releasePointerCapture(pointer.id);
    }
    if (pointer && this.view.current) this.view.refresh();
  }

  destroy() {
    this.cancel();
    for (const [type, handler] of this.listeners) {
      this.canvas.removeEventListener(type, handler);
    }
    this.listeners.clear();
  }
}
