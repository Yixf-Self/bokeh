import {CartesianFrame} from "../canvas/cartesian_frame"
import {Canvas, CanvasView, FrameBox} from "../canvas/canvas"
import {Range} from "../ranges/range"
import {DataRange1d, Bounds} from "../ranges/data_range1d"
import {Renderer, RendererView} from "../renderers/renderer"
import {GlyphRenderer, GlyphRendererView} from "../renderers/glyph_renderer"
import {Tool, ToolView} from "../tools/tool"
import {Selection} from "../selections/selection"
import {LayoutDOM, LayoutDOMView} from "../layouts/layout_dom"
import {Annotation, AnnotationView} from "../annotations/annotation"
import {Title} from "../annotations/title"
import {Axis, AxisView} from "../axes/axis"
import {ToolbarPanel} from "../annotations/toolbar_panel"

import {Reset} from "core/bokeh_events"
import {Arrayable, Interval} from "core/types"
import {Signal0} from "core/signaling"
import {build_views, remove_views} from "core/build_views"
import {Visuals} from "core/visuals"
import {logger} from "core/logging"
import {Side} from "core/enums"
import {isArray} from "core/util/types"
import {copy, reversed} from "core/util/array"
import {values} from "core/util/object"
import {Context2d} from "core/util/canvas"
import {SizingPolicy, Layoutable} from "core/layout"
import {HStack, VStack} from "core/layout/alignments"
import {BorderLayout} from "core/layout/border"
import {SidePanel} from "core/layout/side_panel"
import {Row, Column} from "core/layout/grid"

import {Location, Place, ResetPolicy} from "core/enums"
import {concat, remove_by} from "core/util/array"

import {Grid} from "../grids/grid"
import {GuideRenderer} from "../renderers/guide_renderer"
import {LinearScale} from "../scales/linear_scale"
import {Toolbar} from "../tools/toolbar"

import {Scale} from "../scales/scale"
import {Glyph} from "../glyphs/glyph"
import {DataSource} from "../sources/data_source"
import {ColumnDataSource} from "../sources/column_data_source"
import {DataRenderer} from "../renderers/data_renderer"

import * as visuals from "core/visuals"
import * as mixins from "core/property_mixins"
import * as p from "core/properties"

export type RangeInfo = {
  xrs: {[key: string]: Interval}
  yrs: {[key: string]: Interval}
}

export type StateInfo = {
  range?: RangeInfo
  selection: {[key: string]: Selection}
  dimensions: {
    width: number
    height: number
  }
}

export class PlotCanvasView extends LayoutDOMView {
  model: PlotCanvas
  visuals: PlotCanvas.Visuals

  layout: BorderLayout

  frame: CartesianFrame

  get canvas_view(): CanvasView {
    return (this.parent as any).canvas_view // XXX: parent must be a canvas provider
  }

  get canvas(): Canvas {
    return this.canvas_view.model
  }

  protected _title: Title
  protected _toolbar: ToolbarPanel

  protected _needs_layout: boolean = false

  state_changed: Signal0<this>
  visibility_callbacks: ((visible: boolean) => void)[]

  protected _initial_state_info: StateInfo

  protected state: {
    history: {type: string, info: StateInfo}[]
    index: number
  }

  computed_renderers: Renderer[]

  /*protected*/ renderer_views: Map<Renderer, RendererView>
  /*protected*/ tool_views: Map<Tool, ToolView>

  protected range_update_timestamp?: number

  get child_models(): LayoutDOM[] {
    return []
  }

  // TODO: this needs to be removed
  request_render(): void {
    this.request_paint()
  }

  request_paint(): void {
    this.canvas_view.request_paint(this)
  }

  request_layout(): void {
    this._needs_layout = true
    this.request_paint()
  }

  reset(): void {
    if (this.model.reset_policy == "standard") {
      this.clear_state()
      this.reset_range()
      this.reset_selection()
    }
    this.model.trigger_event(new Reset())
  }

  remove(): void {
    remove_views(this.renderer_views)
    remove_views(this.tool_views)
    super.remove()
  }

  initialize(): void {
    super.initialize()

    this.state_changed = new Signal0(this, "state_changed")

    this.visuals = new Visuals(this.model) as any // XXX

    this._initial_state_info = {
      selection: {},                      // XXX: initial selection?
      dimensions: {width: 0, height: 0},  // XXX: initial dimensions
    }
    this.visibility_callbacks = []

    this.state = {history: [], index: -1}

    this.frame = new CartesianFrame(
      this.model.x_scale,
      this.model.y_scale,
      this.model.x_range,
      this.model.y_range,
      this.model.extra_x_ranges,
      this.model.extra_y_ranges,
    )

    const {title_location, title} = this.model
    if (title_location != null && title != null) {
      this._title = title instanceof Title ? title : new Title({text: title})
    }

    const {toolbar_location, toolbar} = this.model
    if (toolbar_location != null && toolbar != null) {
      this._toolbar = new ToolbarPanel({toolbar})
      toolbar.toolbar_location = toolbar_location
    }

    this.renderer_views = new Map()
    this.tool_views = new Map()
  }

  async lazy_initialize(): Promise<void> {
    await this.build_renderer_views()
    await this.build_tool_views()

    this.update_dataranges()
  }

  protected _width_policy(): SizingPolicy {
    return this.model.frame_width == null ? super._width_policy() : "min"
  }

  protected _height_policy(): SizingPolicy {
    return this.model.frame_height == null ? super._height_policy() : "min"
  }

  _update_layout(): void {
    this.layout = new BorderLayout()
    this.layout.absolute = true
    this.layout.set_sizing(this.box_sizing())

    const {frame_width, frame_height} = this.model

    this.layout.center_panel = this.frame
    this.layout.center_panel.set_sizing({
      ...(frame_width  != null ? {width_policy:  "fixed", width:  frame_width } : {width_policy:  "fit"}),
      ...(frame_height != null ? {height_policy: "fixed", height: frame_height} : {height_policy: "fit"}),
    })

    type Panels = (Axis | Annotation | Annotation[])[]

    const above: Panels = copy(this.model.above)
    const below: Panels = copy(this.model.below)
    const left:  Panels = copy(this.model.left)
    const right: Panels = copy(this.model.right)

    const get_side = (side: Side): Panels => {
      switch (side) {
        case "above": return above
        case "below": return below
        case "left":  return left
        case "right": return right
      }
    }

    const {title_location, title} = this.model
    if (title_location != null && title != null) {
      get_side(title_location).push(this._title)
    }

    const {toolbar_location, toolbar} = this.model
    if (toolbar_location != null && toolbar != null) {
      const panels = get_side(toolbar_location)
      let push_toolbar = true

      if (this.model.toolbar_sticky) {
        for (let i = 0; i < panels.length; i++) {
          const panel = panels[i]
          if (panel instanceof Title) {
            if (toolbar_location == "above" || toolbar_location == "below")
              panels[i] = [panel, this._toolbar]
            else
              panels[i] = [this._toolbar, panel]
            push_toolbar = false
            break
          }
        }
      }

      if (push_toolbar)
        panels.push(this._toolbar)
    }

    const set_layout = (side: Side, model: Annotation | Axis): SidePanel => {
      const view = this.renderer_views.get(model)! as AnnotationView | AxisView
      return view.layout = new SidePanel(side, view)
    }

    const set_layouts = (side: Side, panels: Panels) => {
      const horizontal = side == "above" || side == "below"
      const layouts: Layoutable[] = []

      for (const panel of panels) {
        if (isArray(panel)) {
          const items = panel.map((subpanel) => {
            const item = set_layout(side, subpanel)
            if (subpanel instanceof ToolbarPanel) {
              const dim = horizontal ? "width_policy" : "height_policy"
              item.set_sizing({...item.sizing, [dim]: "min"})
            }
            return item
          })

          let layout: Row | Column
          if (horizontal) {
            layout = new Row(items)
            layout.set_sizing({width_policy: "max", height_policy: "min"})
          } else {
            layout = new Column(items)
            layout.set_sizing({width_policy: "min", height_policy: "max"})
          }

          layout.absolute = true
          layouts.push(layout)
        } else
          layouts.push(set_layout(side, panel))
      }

      return layouts
    }

    const min_border = this.model.min_border != null ? this.model.min_border : 0
    this.layout.min_border = {
      left:   this.model.min_border_left   != null ? this.model.min_border_left   : min_border,
      top:    this.model.min_border_top    != null ? this.model.min_border_top    : min_border,
      right:  this.model.min_border_right  != null ? this.model.min_border_right  : min_border,
      bottom: this.model.min_border_bottom != null ? this.model.min_border_bottom : min_border,
    }

    const top_panel    = new VStack()
    const bottom_panel = new VStack()
    const left_panel   = new HStack()
    const right_panel  = new HStack()

    top_panel.children    = reversed(set_layouts("above", above))
    bottom_panel.children =          set_layouts("below", below)
    left_panel.children   = reversed(set_layouts("left",  left))
    right_panel.children  =          set_layouts("right", right)

    top_panel.set_sizing({width_policy: "fit", height_policy: "min"/*, min_height: this.layout.min_border.top*/})
    bottom_panel.set_sizing({width_policy: "fit", height_policy: "min"/*, min_height: this.layout.min_width.bottom*/})
    left_panel.set_sizing({width_policy: "min", height_policy: "fit"/*, min_width: this.layout.min_width.left*/})
    right_panel.set_sizing({width_policy: "min", height_policy: "fit"/*, min_width: this.layout.min_width.right*/})

    this.layout.top_panel = top_panel
    this.layout.bottom_panel = bottom_panel
    this.layout.left_panel = left_panel
    this.layout.right_panel = right_panel
  }

  get axis_views(): AxisView[] {
    const views = []
    for (const [, renderer_view] of this.renderer_views) {
      if (renderer_view instanceof AxisView)
        views.push(renderer_view)
    }
    return views
  }

  set_toolbar_visibility(visible: boolean): void {
    for (const callback of this.visibility_callbacks)
      callback(visible)
  }


  update_dataranges(): void {
    // Update any DataRange1ds here
    const bounds: Bounds = new Map()
    const log_bounds: Bounds = new Map()

    let calculate_log_bounds = false
    for (const r of values(this.frame.x_ranges).concat(values(this.frame.y_ranges))) {
      if (r instanceof DataRange1d) {
        if (r.scale_hint == "log")
          calculate_log_bounds = true
      }
    }

    for (const [renderer, renderer_view] of this.renderer_views) {
      if (renderer_view instanceof GlyphRendererView) {
        const bds = renderer_view.glyph.bounds()
        if (bds != null)
          bounds.set(renderer, bds)

        if (calculate_log_bounds) {
          const log_bds = renderer_view.glyph.log_bounds()
          if (log_bds != null)
            log_bounds.set(renderer, log_bds)
        }
      }
    }

    let follow_enabled = false
    let has_bounds = false

    const {width, height} = this.frame.bbox
    let r: number | undefined
    if (this.model.match_aspect !== false && width != 0 && height != 0)
      r = (1/this.model.aspect_scale)*(width/height)

    for (const xr of values(this.frame.x_ranges)) {
      if (xr instanceof DataRange1d) {
        const bounds_to_use = xr.scale_hint == "log" ? log_bounds : bounds
        xr.update(bounds_to_use, 0, this.model, r)
        if (xr.follow) {
          follow_enabled = true
        }
      }
      if (xr.bounds != null)
        has_bounds = true
    }

    for (const yr of values(this.frame.y_ranges)) {
      if (yr instanceof DataRange1d) {
        const bounds_to_use = yr.scale_hint == "log" ? log_bounds : bounds
        yr.update(bounds_to_use, 1, this.model, r)
        if (yr.follow) {
          follow_enabled = true
        }
      }
      if (yr.bounds != null)
        has_bounds = true
    }

    if (follow_enabled && has_bounds) {
      logger.warn('Follow enabled so bounds are unset.')
      for (const xr of values(this.frame.x_ranges)) {
        xr.bounds = null
      }
      for (const yr of values(this.frame.y_ranges)) {
        yr.bounds = null
      }
    }

    this.range_update_timestamp = Date.now()
  }

  map_to_screen(x: Arrayable<number>, y: Arrayable<number>,
                x_name: string = "default", y_name: string = "default"): [Arrayable<number>, Arrayable<number>] {
    return this.frame.map_to_screen(x, y, x_name, y_name)
  }

  push_state(type: string, new_info: Partial<StateInfo>): void {
    const {history, index} = this.state

    const prev_info = history[index] != null ? history[index].info : {}
    const info = {...this._initial_state_info, ...prev_info, ...new_info}

    this.state.history = this.state.history.slice(0, this.state.index + 1)
    this.state.history.push({type, info})
    this.state.index = this.state.history.length - 1

    this.state_changed.emit()
  }

  clear_state(): void {
    this.state = {history: [], index: -1}
    this.state_changed.emit()
  }

  can_undo(): boolean {
    return this.state.index >= 0
  }

  can_redo(): boolean {
    return this.state.index < this.state.history.length - 1
  }

  undo(): void {
    if (this.can_undo()) {
      this.state.index -= 1
      this._do_state_change(this.state.index)
      this.state_changed.emit()
    }
  }

  redo(): void {
    if (this.can_redo()) {
      this.state.index += 1
      this._do_state_change(this.state.index)
      this.state_changed.emit()
    }
  }

  protected _do_state_change(index: number): void {
    const info = this.state.history[index] != null ? this.state.history[index].info : this._initial_state_info

    if (info.range != null)
      this.update_range(info.range)

    if (info.selection != null)
      this.update_selection(info.selection)
  }

  get_selection(): {[key: string]: Selection} {
    const selection: {[key: string]: Selection} = {}
    for (const renderer of this.model.renderers) {
      if (renderer instanceof GlyphRenderer) {
        const {selected} = renderer.data_source
        selection[renderer.id] = selected
      }
    }
    return selection
  }

  update_selection(selection: {[key: string]: Selection} | null): void {
    for (const renderer of this.model.renderers) {
      if (!(renderer instanceof GlyphRenderer))
        continue

      const ds = renderer.data_source
      if (selection != null) {
        if (selection[renderer.id] != null)
          ds.selected.update(selection[renderer.id], true)
      } else
        ds.selection_manager.clear()
    }
  }

  reset_selection(): void {
    this.update_selection(null)
  }

  protected _update_ranges_together(range_info_iter: [Range, Interval][]): void {
    // Get weight needed to scale the diff of the range to honor interval limits
    let weight = 1.0
    for (const [rng, range_info] of range_info_iter) {
      weight = Math.min(weight, this._get_weight_to_constrain_interval(rng, range_info))
    }
    // Apply shared weight to all ranges
    if (weight < 1) {
      for (const [rng, range_info] of range_info_iter) {
        range_info.start = weight*range_info.start + (1 - weight)*rng.start
        range_info.end = weight*range_info.end + (1 - weight)*rng.end
      }
    }
  }

  protected _update_ranges_individually(range_info_iter: [Range, Interval][],
                                        is_panning: boolean, is_scrolling: boolean, maintain_focus: boolean): void {
    let hit_bound = false
    for (const [rng, range_info] of range_info_iter) {

      // Limit range interval first. Note that for scroll events,
      // the interval has already been limited for all ranges simultaneously
      if (!is_scrolling) {
        const weight = this._get_weight_to_constrain_interval(rng, range_info)
        if (weight < 1) {
          range_info.start = weight*range_info.start + (1 - weight)*rng.start
          range_info.end = weight*range_info.end + (1 - weight)*rng.end
        }
      }

      // Prevent range from going outside limits
      // Also ensure that range keeps the same delta when panning/scrolling
      if (rng.bounds != null && rng.bounds != "auto") { // check `auto` for type-checking purpose
        const [min, max] = rng.bounds
        const new_interval = Math.abs(range_info.end - range_info.start)

        if (rng.is_reversed) {
          if (min != null) {
            if (min >= range_info.end) {
              hit_bound = true
              range_info.end = min
              if (is_panning || is_scrolling) {
                range_info.start = min + new_interval
              }
            }
          }
          if (max != null) {
            if (max <= range_info.start) {
              hit_bound = true
              range_info.start = max
              if (is_panning || is_scrolling) {
                range_info.end = max - new_interval
              }
            }
          }
        } else {
          if (min != null) {
            if (min >= range_info.start) {
              hit_bound = true
              range_info.start = min
              if (is_panning || is_scrolling) {
                range_info.end = min + new_interval
              }
            }
          }
          if (max != null) {
            if (max <= range_info.end) {
              hit_bound = true
              range_info.end = max
              if (is_panning || is_scrolling) {
                range_info.start = max - new_interval
              }
            }
          }
        }
      }
    }

    // Cancel the event when hitting a bound while scrolling. This ensures that
    // the scroll-zoom tool maintains its focus position. Setting `maintain_focus`
    // to false results in a more "gliding" behavior, allowing one to
    // zoom out more smoothly, at the cost of losing the focus position.
    if (is_scrolling && hit_bound && maintain_focus)
      return

    for (const [rng, range_info] of range_info_iter) {
      rng.have_updated_interactively = true
      if (rng.start != range_info.start || rng.end != range_info.end)
        rng.setv(range_info)
    }
  }

  protected _get_weight_to_constrain_interval(rng: Range, range_info: Interval): number {
    // Get the weight by which a range-update can be applied
    // to still honor the interval limits (including the implicit
    // max interval imposed by the bounds)
    const {min_interval} = rng
    let {max_interval} = rng

    // Express bounds as a max_interval. By doing this, the application of
    // bounds and interval limits can be applied independent from each-other.
    if (rng.bounds != null && rng.bounds != "auto") { // check `auto` for type-checking purpose
      const [min, max] = rng.bounds
      if (min != null && max != null) {
        const max_interval2 = Math.abs(max - min)
        max_interval = max_interval != null ? Math.min(max_interval, max_interval2) : max_interval2
      }
    }

    let weight = 1.0
    if (min_interval != null || max_interval != null) {
      const old_interval = Math.abs(rng.end - rng.start)
      const new_interval = Math.abs(range_info.end - range_info.start)
      if (min_interval > 0 && new_interval < min_interval) {
        weight = (old_interval - min_interval) / (old_interval - new_interval)
      }
      if (max_interval > 0 && new_interval > max_interval) {
        weight = (max_interval - old_interval) / (new_interval - old_interval)
      }
      weight = Math.max(0.0, Math.min(1.0, weight))
    }
    return weight
  }

  update_range(range_info: RangeInfo | null,
               is_panning: boolean = false, is_scrolling: boolean = false, maintain_focus: boolean = true): void {
    //this.canvas_view.pause()
    const {x_ranges, y_ranges} = this.frame
    if (range_info == null) {
      for (const name in x_ranges) {
        const rng = x_ranges[name]
        rng.reset()
      }
      for (const name in y_ranges) {
        const rng = y_ranges[name]
        rng.reset()
      }
      this.update_dataranges()
    } else {
      const range_info_iter: [Range, Interval][] = []
      for (const name in x_ranges) {
        const rng = x_ranges[name]
        range_info_iter.push([rng, range_info.xrs[name]])
      }
      for (const name in y_ranges) {
        const rng = y_ranges[name]
        range_info_iter.push([rng, range_info.yrs[name]])
      }
      if (is_scrolling) {
        this._update_ranges_together(range_info_iter)   // apply interval bounds while keeping aspect
      }
      this._update_ranges_individually(range_info_iter, is_panning, is_scrolling, maintain_focus)
    }
    //this.canvas_view.unpause()
  }

  reset_range(): void {
    this.update_range(null)
  }

  protected _invalidate_layout(): void {
    const needs_layout = () => {
      for (const panel of this.model.side_panels) {
        const view = this.renderer_views.get(panel)! as AnnotationView | AxisView
        if (view.layout.has_size_changed())
          return true
      }
      return false
    }

    if (needs_layout())
      this.root.compute_layout()
  }

  get_renderer_views(): RendererView[] {
    return this.computed_renderers.map((r) => this.renderer_views.get(r)!)
  }

  async build_renderer_views(): Promise<void> {
    this.computed_renderers = []

    const {above, below, left, right, center, renderers} = this.model
    this.computed_renderers.push(...above, ...below, ...left, ...right, ...center, ...renderers)

    if (this._title != null)
      this.computed_renderers.push(this._title)

    if (this._toolbar != null)
      this.computed_renderers.push(this._toolbar)

    for (const tool of this.model.toolbar.tools) {
      if (tool.overlay != null)
        this.computed_renderers.push(tool.overlay)

      this.computed_renderers.push(...tool.synthetic_renderers)
    }

    await build_views(this.renderer_views, this.computed_renderers, {parent: this})
  }

  async build_tool_views(): Promise<void> {
    const tool_models = this.model.toolbar.tools
    const new_tool_views = await build_views(this.tool_views, tool_models, {parent: this}) as ToolView[]
    new_tool_views.map((tool_view) => this.canvas_view.ui_event_bus.register_tool(tool_view))
  }

  connect_signals(): void {
    super.connect_signals()

    const {x_ranges, y_ranges} = this.frame

    for (const name in x_ranges) {
      const rng = x_ranges[name]
      this.connect(rng.change, () => this.request_layout())
    }
    for (const name in y_ranges) {
      const rng = y_ranges[name]
      this.connect(rng.change, () => this.request_layout())
    }

    const {above, below, left, right, center, renderers} = this.model.properties
    this.on_change([above, below, left, right, center, renderers], async () => await this.build_renderer_views())

    this.connect(this.model.toolbar.properties.tools.change, async () => {
      await this.build_renderer_views()
      await this.build_tool_views()
    })

    this.connect(this.model.change, () => this.request_paint())
    this.connect(this.model.reset, () => this.reset())
  }

  set_initial_range(): void {
    // check for good values for ranges before setting initial range
    let good_vals = true
    const {x_ranges, y_ranges} = this.frame
    const xrs: {[key: string]: Interval} = {}
    const yrs: {[key: string]: Interval} = {}
    for (const name in x_ranges) {
      const {start, end} = x_ranges[name]
      if (start == null || end == null || isNaN(start + end)) {
        good_vals = false
        break
      }
      xrs[name] = {start, end}
    }
    if (good_vals) {
      for (const name in y_ranges) {
        const {start, end} = y_ranges[name]
        if (start == null || end == null || isNaN(start + end)) {
          good_vals = false
          break
        }
        yrs[name] = {start, end}
      }
    }
    if (good_vals) {
      this._initial_state_info.range = {xrs, yrs}
      logger.debug("initial ranges set")
    } else
      logger.warn('could not set initial ranges')
  }

  has_finished(): boolean {
    if (!super.has_finished())
      return false

    for (const [, renderer_view] of this.renderer_views) {
      if (!renderer_view.has_finished())
        return false
    }

    return true
  }

  dirty: boolean = true

  after_layout(): void {
    super.after_layout()

    this._needs_layout = false

    this.model.setv({
      inner_width: Math.round(this.frame._width.value),
      inner_height: Math.round(this.frame._height.value),
      outer_width: Math.round(this.layout._width.value),
      outer_height: Math.round(this.layout._height.value),
    }, {no_change: true})

    if (this.model.match_aspect !== false) {
      //this.canvas_view.pause()
      this.update_dataranges()
      //this.canvas_view.unpause(true)
    }
  }

  repaint(): void {
    if (this._needs_layout)
      this._invalidate_layout()
    this.paint()
  }

  paint(): void {
    for (const [, renderer_view] of this.renderer_views) {
      if (this.range_update_timestamp == null ||
          (renderer_view instanceof GlyphRendererView && renderer_view.set_data_timestamp > this.range_update_timestamp)) {
        this.update_dataranges()
        break
      }
    }

    if (this._initial_state_info.range == null)
      this.set_initial_range()

    const frame_box: FrameBox = [
      this.frame._left.value,
      this.frame._top.value,
      this.frame._width.value,
      this.frame._height.value,
    ]

    const {primary} = this.canvas_view

    this._map_hook(primary.ctx, frame_box)
    this._paint_empty(primary.ctx, frame_box)
    this._paint_outline(primary.ctx, frame_box)
  }

  protected _map_hook(_ctx: Context2d, _frame_box: FrameBox): void {}

  protected _paint_empty(ctx: Context2d, frame_box: FrameBox): void {
    const {x, y, width: w, height: h} = this.layout.bbox
    const [fx, fy, fw, fh] = frame_box

    if (this.visuals.border_fill.doit) {
      this.visuals.border_fill.set_value(ctx)
      ctx.fillRect(x, y, w, h)
      ctx.clearRect(fx, fy, fw, fh)
    }

    if (this.visuals.background_fill.doit) {
      this.visuals.background_fill.set_value(ctx)
      ctx.fillRect(fx, fy, fw, fh)
    }
  }

  protected _paint_outline(ctx: Context2d, frame_box: FrameBox): void {
    if (this.visuals.outline_line.doit) {
      ctx.save()
      this.visuals.outline_line.set_value(ctx)
      let [x0, y0, w, h] = frame_box
      // XXX: shrink outline region by 1px to make right and bottom lines visible
      // if they are on the edge of the canvas.
      if (x0 + w == this.layout._width.value) {
        w -= 1
      }
      if (y0 + h == this.layout._height.value) {
        h -= 1
      }
      ctx.strokeRect(x0, y0, w, h)
      ctx.restore()
    }
  }

  save(name: string): void {
    this.canvas_view.save(name)
  }

  serializable_state(): {[key: string]: unknown} {
    const {children, ...state} = super.serializable_state()
    const renderers = this.get_renderer_views()
      .map((view) => view.serializable_state())
      .filter((item) => "bbox" in item)
    return {...state, children: [...(children as any), ...renderers]} // XXX
  }
}

export namespace PlotCanvas {
  export type Attrs = p.AttrsOf<Props>

  export type Props = LayoutDOM.Props & {
    toolbar: p.Property<Toolbar>
    toolbar_location: p.Property<Location | null>
    toolbar_sticky: p.Property<boolean>

    plot_width: p.Property<number>
    plot_height: p.Property<number>

    frame_width: p.Property<number | null>
    frame_height: p.Property<number | null>

    title: p.Property<Title | string | null>
    title_location: p.Property<Location | null>

    above: p.Property<(Annotation | Axis)[]>
    below: p.Property<(Annotation | Axis)[]>
    left: p.Property<(Annotation | Axis)[]>
    right: p.Property<(Annotation | Axis)[]>
    center: p.Property<(Annotation | Grid)[]>

    renderers: p.Property<DataRenderer[]>

    x_range: p.Property<Range>
    extra_x_ranges: p.Property<{[key: string]: Range}>
    y_range: p.Property<Range>
    extra_y_ranges: p.Property<{[key: string]: Range}>

    x_scale: p.Property<Scale>
    y_scale: p.Property<Scale>

    min_border: p.Property<number | null>
    min_border_top: p.Property<number | null>
    min_border_left: p.Property<number | null>
    min_border_bottom: p.Property<number | null>
    min_border_right: p.Property<number | null>

    inner_width: p.Property<number>
    inner_height: p.Property<number>
    outer_width: p.Property<number>
    outer_height: p.Property<number>

    match_aspect: p.Property<boolean>
    aspect_scale: p.Property<number>

    reset_policy: p.Property<ResetPolicy>
  } & Mixins

  export type Mixins =
    mixins.OutlineLine    &
    mixins.BackgroundFill &
    mixins.BorderFill

  export type Visuals = visuals.Visuals & {
    outline_line: visuals.Line
    background_fill: visuals.Fill
    border_fill: visuals.Fill
  }
}

export interface PlotCanvas extends PlotCanvas.Attrs {}

export class PlotCanvas extends LayoutDOM {
  properties: PlotCanvas.Props
  __view_type__: PlotCanvasView

  constructor(attrs?: Partial<PlotCanvas.Attrs>) {
    super(attrs)
  }

  static init_PlotCanvas(): void {
    this.prototype.default_view = PlotCanvasView

    this.mixins<PlotCanvas.Mixins>([
      ["outline_",    mixins.Line],
      ["background_", mixins.Fill],
      ["border_",     mixins.Fill],
    ])

    this.define<PlotCanvas.Props>({
      toolbar:           [ p.Instance, () => new Toolbar()     ],
      toolbar_location:  [ p.Location, "right"                 ],
      toolbar_sticky:    [ p.Boolean,  true                    ],

      plot_width:        [ p.Number,   600                     ],
      plot_height:       [ p.Number,   600                     ],

      frame_width:       [ p.Number,   null                    ],
      frame_height:      [ p.Number,   null                    ],

      title:             [ p.Any,      () => new Title({text: ""})  ], // TODO: p.Either(p.Instance(Title), p.String)
      title_location:    [ p.Location, "above"                 ],

      above:             [ p.Array,    []                      ],
      below:             [ p.Array,    []                      ],
      left:              [ p.Array,    []                      ],
      right:             [ p.Array,    []                      ],
      center:            [ p.Array,    []                      ],

      renderers:         [ p.Array,    []                      ],

      x_range:           [ p.Instance, () => new DataRange1d() ],
      extra_x_ranges:    [ p.Any,      {}                      ], // TODO (bev)
      y_range:           [ p.Instance, () => new DataRange1d() ],
      extra_y_ranges:    [ p.Any,      {}                      ], // TODO (bev)

      x_scale:           [ p.Instance, () => new LinearScale() ],
      y_scale:           [ p.Instance, () => new LinearScale() ],

      min_border:        [ p.Number,   5                       ],
      min_border_top:    [ p.Number,   null                    ],
      min_border_left:   [ p.Number,   null                    ],
      min_border_bottom: [ p.Number,   null                    ],
      min_border_right:  [ p.Number,   null                    ],

      inner_width:       [ p.Number                            ],
      inner_height:      [ p.Number                            ],
      outer_width:       [ p.Number                            ],
      outer_height:      [ p.Number                            ],

      match_aspect:      [ p.Boolean,  false                   ],
      aspect_scale:      [ p.Number,   1                       ],

      reset_policy:      [ p.ResetPolicy,  "standard"          ],
    })

    this.override({
      outline_line_color: "#e5e5e5",
      border_fill_color: "#ffffff",
      background_fill_color: "#ffffff",
    })
  }

  reset: Signal0<this>

  initialize(): void {
    super.initialize()

    this.reset = new Signal0(this, "reset")

    for (const xr of values(this.extra_x_ranges).concat(this.x_range)) {
      let plots = xr.plots
      if (isArray(plots)) {
        plots = plots.concat(this)
        xr.setv({plots}, {silent: true})
      }
    }

    for (const yr of values(this.extra_y_ranges).concat(this.y_range)) {
      let plots = yr.plots
      if (isArray(plots)) {
        plots = plots.concat(this)
        yr.setv({plots}, {silent: true})
      }
    }
  }

  add_layout(renderer: Annotation | GuideRenderer, side: Place = "center"): void {
    const renderers = this.properties[side].get_value()
    this.setv({[side]: [...renderers, renderer]})
  }

  remove_layout(renderer: Annotation | GuideRenderer): void {

    const del = (items: (Annotation | GuideRenderer)[]): void => {
      remove_by(items, (item) => item == renderer)
    }

    del(this.left)
    del(this.right)
    del(this.above)
    del(this.below)
    del(this.center)
  }

  add_renderers(...renderers: DataRenderer[]): void {
    this.renderers = this.renderers.concat(renderers)
  }

  add_glyph(glyph: Glyph, source: DataSource = new ColumnDataSource(), extra_attrs: any = {}): GlyphRenderer {
    const attrs = {...extra_attrs, data_source: source, glyph}
    const renderer = new GlyphRenderer(attrs)
    this.add_renderers(renderer)
    return renderer
  }

  add_tools(...tools: Tool[]): void {
    this.toolbar.tools = this.toolbar.tools.concat(tools)
  }

  get panels(): (Annotation | Axis | Grid)[] {
    return [...this.side_panels, ...this.center]
  }

  get side_panels(): (Annotation | Axis)[] {
    const {above, below, left, right} = this
    return concat([above, below, left, right])
  }

  level = null
}
