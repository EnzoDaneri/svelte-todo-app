var app = (function () {
    'use strict';

    function noop() { }
    const identity = x => x;
    function assign(tar, src) {
        // @ts-ignore
        for (const k in src)
            tar[k] = src[k];
        return tar;
    }
    function run(fn) {
        return fn();
    }
    function blank_object() {
        return Object.create(null);
    }
    function run_all(fns) {
        fns.forEach(run);
    }
    function is_function(thing) {
        return typeof thing === 'function';
    }
    function safe_not_equal(a, b) {
        return a != a ? b == b : a !== b || ((a && typeof a === 'object') || typeof a === 'function');
    }

    const is_client = typeof window !== 'undefined';
    let now = is_client
        ? () => window.performance.now()
        : () => Date.now();
    let raf = is_client ? cb => requestAnimationFrame(cb) : noop;

    const tasks = new Set();
    function run_tasks(now) {
        tasks.forEach(task => {
            if (!task.c(now)) {
                tasks.delete(task);
                task.f();
            }
        });
        if (tasks.size !== 0)
            raf(run_tasks);
    }
    /**
     * Creates a new task that runs on each raf frame
     * until it returns a falsy value or is aborted
     */
    function loop(callback) {
        let task;
        if (tasks.size === 0)
            raf(run_tasks);
        return {
            promise: new Promise(fulfill => {
                tasks.add(task = { c: callback, f: fulfill });
            }),
            abort() {
                tasks.delete(task);
            }
        };
    }

    function append(target, node) {
        target.appendChild(node);
    }
    function insert(target, node, anchor) {
        target.insertBefore(node, anchor || null);
    }
    function detach(node) {
        node.parentNode.removeChild(node);
    }
    function destroy_each(iterations, detaching) {
        for (let i = 0; i < iterations.length; i += 1) {
            if (iterations[i])
                iterations[i].d(detaching);
        }
    }
    function element(name) {
        return document.createElement(name);
    }
    function text(data) {
        return document.createTextNode(data);
    }
    function space() {
        return text(' ');
    }
    function listen(node, event, handler, options) {
        node.addEventListener(event, handler, options);
        return () => node.removeEventListener(event, handler, options);
    }
    function attr(node, attribute, value) {
        if (value == null)
            node.removeAttribute(attribute);
        else if (node.getAttribute(attribute) !== value)
            node.setAttribute(attribute, value);
    }
    function children(element) {
        return Array.from(element.childNodes);
    }
    function set_data(text, data) {
        data = '' + data;
        if (text.data !== data)
            text.data = data;
    }
    function set_input_value(input, value) {
        input.value = value == null ? '' : value;
    }
    function toggle_class(element, name, toggle) {
        element.classList[toggle ? 'add' : 'remove'](name);
    }
    function custom_event(type, detail) {
        const e = document.createEvent('CustomEvent');
        e.initCustomEvent(type, false, false, detail);
        return e;
    }

    const active_docs = new Set();
    let active = 0;
    // https://github.com/darkskyapp/string-hash/blob/master/index.js
    function hash(str) {
        let hash = 5381;
        let i = str.length;
        while (i--)
            hash = ((hash << 5) - hash) ^ str.charCodeAt(i);
        return hash >>> 0;
    }
    function create_rule(node, a, b, duration, delay, ease, fn, uid = 0) {
        const step = 16.666 / duration;
        let keyframes = '{\n';
        for (let p = 0; p <= 1; p += step) {
            const t = a + (b - a) * ease(p);
            keyframes += p * 100 + `%{${fn(t, 1 - t)}}\n`;
        }
        const rule = keyframes + `100% {${fn(b, 1 - b)}}\n}`;
        const name = `__svelte_${hash(rule)}_${uid}`;
        const doc = node.ownerDocument;
        active_docs.add(doc);
        const stylesheet = doc.__svelte_stylesheet || (doc.__svelte_stylesheet = doc.head.appendChild(element('style')).sheet);
        const current_rules = doc.__svelte_rules || (doc.__svelte_rules = {});
        if (!current_rules[name]) {
            current_rules[name] = true;
            stylesheet.insertRule(`@keyframes ${name} ${rule}`, stylesheet.cssRules.length);
        }
        const animation = node.style.animation || '';
        node.style.animation = `${animation ? `${animation}, ` : ``}${name} ${duration}ms linear ${delay}ms 1 both`;
        active += 1;
        return name;
    }
    function delete_rule(node, name) {
        const previous = (node.style.animation || '').split(', ');
        const next = previous.filter(name
            ? anim => anim.indexOf(name) < 0 // remove specific animation
            : anim => anim.indexOf('__svelte') === -1 // remove all Svelte animations
        );
        const deleted = previous.length - next.length;
        if (deleted) {
            node.style.animation = next.join(', ');
            active -= deleted;
            if (!active)
                clear_rules();
        }
    }
    function clear_rules() {
        raf(() => {
            if (active)
                return;
            active_docs.forEach(doc => {
                const stylesheet = doc.__svelte_stylesheet;
                let i = stylesheet.cssRules.length;
                while (i--)
                    stylesheet.deleteRule(i);
                doc.__svelte_rules = {};
            });
            active_docs.clear();
        });
    }

    let current_component;
    function set_current_component(component) {
        current_component = component;
    }
    function get_current_component() {
        if (!current_component)
            throw new Error(`Function called outside component initialization`);
        return current_component;
    }
    function createEventDispatcher() {
        const component = get_current_component();
        return (type, detail) => {
            const callbacks = component.$$.callbacks[type];
            if (callbacks) {
                // TODO are there situations where events could be dispatched
                // in a server (non-DOM) environment?
                const event = custom_event(type, detail);
                callbacks.slice().forEach(fn => {
                    fn.call(component, event);
                });
            }
        };
    }

    const dirty_components = [];
    const binding_callbacks = [];
    const render_callbacks = [];
    const flush_callbacks = [];
    const resolved_promise = Promise.resolve();
    let update_scheduled = false;
    function schedule_update() {
        if (!update_scheduled) {
            update_scheduled = true;
            resolved_promise.then(flush);
        }
    }
    function add_render_callback(fn) {
        render_callbacks.push(fn);
    }
    let flushing = false;
    const seen_callbacks = new Set();
    function flush() {
        if (flushing)
            return;
        flushing = true;
        do {
            // first, call beforeUpdate functions
            // and update components
            for (let i = 0; i < dirty_components.length; i += 1) {
                const component = dirty_components[i];
                set_current_component(component);
                update(component.$$);
            }
            dirty_components.length = 0;
            while (binding_callbacks.length)
                binding_callbacks.pop()();
            // then, once components are updated, call
            // afterUpdate functions. This may cause
            // subsequent updates...
            for (let i = 0; i < render_callbacks.length; i += 1) {
                const callback = render_callbacks[i];
                if (!seen_callbacks.has(callback)) {
                    // ...so guard against infinite loops
                    seen_callbacks.add(callback);
                    callback();
                }
            }
            render_callbacks.length = 0;
        } while (dirty_components.length);
        while (flush_callbacks.length) {
            flush_callbacks.pop()();
        }
        update_scheduled = false;
        flushing = false;
        seen_callbacks.clear();
    }
    function update($$) {
        if ($$.fragment !== null) {
            $$.update();
            run_all($$.before_update);
            const dirty = $$.dirty;
            $$.dirty = [-1];
            $$.fragment && $$.fragment.p($$.ctx, dirty);
            $$.after_update.forEach(add_render_callback);
        }
    }

    let promise;
    function wait() {
        if (!promise) {
            promise = Promise.resolve();
            promise.then(() => {
                promise = null;
            });
        }
        return promise;
    }
    function dispatch(node, direction, kind) {
        node.dispatchEvent(custom_event(`${direction ? 'intro' : 'outro'}${kind}`));
    }
    const outroing = new Set();
    let outros;
    function group_outros() {
        outros = {
            r: 0,
            c: [],
            p: outros // parent group
        };
    }
    function check_outros() {
        if (!outros.r) {
            run_all(outros.c);
        }
        outros = outros.p;
    }
    function transition_in(block, local) {
        if (block && block.i) {
            outroing.delete(block);
            block.i(local);
        }
    }
    function transition_out(block, local, detach, callback) {
        if (block && block.o) {
            if (outroing.has(block))
                return;
            outroing.add(block);
            outros.c.push(() => {
                outroing.delete(block);
                if (callback) {
                    if (detach)
                        block.d(1);
                    callback();
                }
            });
            block.o(local);
        }
    }
    const null_transition = { duration: 0 };
    function create_bidirectional_transition(node, fn, params, intro) {
        let config = fn(node, params);
        let t = intro ? 0 : 1;
        let running_program = null;
        let pending_program = null;
        let animation_name = null;
        function clear_animation() {
            if (animation_name)
                delete_rule(node, animation_name);
        }
        function init(program, duration) {
            const d = program.b - t;
            duration *= Math.abs(d);
            return {
                a: t,
                b: program.b,
                d,
                duration,
                start: program.start,
                end: program.start + duration,
                group: program.group
            };
        }
        function go(b) {
            const { delay = 0, duration = 300, easing = identity, tick = noop, css } = config || null_transition;
            const program = {
                start: now() + delay,
                b
            };
            if (!b) {
                // @ts-ignore todo: improve typings
                program.group = outros;
                outros.r += 1;
            }
            if (running_program) {
                pending_program = program;
            }
            else {
                // if this is an intro, and there's a delay, we need to do
                // an initial tick and/or apply CSS animation immediately
                if (css) {
                    clear_animation();
                    animation_name = create_rule(node, t, b, duration, delay, easing, css);
                }
                if (b)
                    tick(0, 1);
                running_program = init(program, duration);
                add_render_callback(() => dispatch(node, b, 'start'));
                loop(now => {
                    if (pending_program && now > pending_program.start) {
                        running_program = init(pending_program, duration);
                        pending_program = null;
                        dispatch(node, running_program.b, 'start');
                        if (css) {
                            clear_animation();
                            animation_name = create_rule(node, t, running_program.b, running_program.duration, 0, easing, config.css);
                        }
                    }
                    if (running_program) {
                        if (now >= running_program.end) {
                            tick(t = running_program.b, 1 - t);
                            dispatch(node, running_program.b, 'end');
                            if (!pending_program) {
                                // we're done
                                if (running_program.b) {
                                    // intro — we can tidy up immediately
                                    clear_animation();
                                }
                                else {
                                    // outro — needs to be coordinated
                                    if (!--running_program.group.r)
                                        run_all(running_program.group.c);
                                }
                            }
                            running_program = null;
                        }
                        else if (now >= running_program.start) {
                            const p = now - running_program.start;
                            t = running_program.a + running_program.d * easing(p / running_program.duration);
                            tick(t, 1 - t);
                        }
                    }
                    return !!(running_program || pending_program);
                });
            }
        }
        return {
            run(b) {
                if (is_function(config)) {
                    wait().then(() => {
                        // @ts-ignore
                        config = config();
                        go(b);
                    });
                }
                else {
                    go(b);
                }
            },
            end() {
                clear_animation();
                running_program = pending_program = null;
            }
        };
    }

    function get_spread_update(levels, updates) {
        const update = {};
        const to_null_out = {};
        const accounted_for = { $$scope: 1 };
        let i = levels.length;
        while (i--) {
            const o = levels[i];
            const n = updates[i];
            if (n) {
                for (const key in o) {
                    if (!(key in n))
                        to_null_out[key] = 1;
                }
                for (const key in n) {
                    if (!accounted_for[key]) {
                        update[key] = n[key];
                        accounted_for[key] = 1;
                    }
                }
                levels[i] = n;
            }
            else {
                for (const key in o) {
                    accounted_for[key] = 1;
                }
            }
        }
        for (const key in to_null_out) {
            if (!(key in update))
                update[key] = undefined;
        }
        return update;
    }
    function get_spread_object(spread_props) {
        return typeof spread_props === 'object' && spread_props !== null ? spread_props : {};
    }
    function create_component(block) {
        block && block.c();
    }
    function mount_component(component, target, anchor) {
        const { fragment, on_mount, on_destroy, after_update } = component.$$;
        fragment && fragment.m(target, anchor);
        // onMount happens before the initial afterUpdate
        add_render_callback(() => {
            const new_on_destroy = on_mount.map(run).filter(is_function);
            if (on_destroy) {
                on_destroy.push(...new_on_destroy);
            }
            else {
                // Edge case - component was destroyed immediately,
                // most likely as a result of a binding initialising
                run_all(new_on_destroy);
            }
            component.$$.on_mount = [];
        });
        after_update.forEach(add_render_callback);
    }
    function destroy_component(component, detaching) {
        const $$ = component.$$;
        if ($$.fragment !== null) {
            run_all($$.on_destroy);
            $$.fragment && $$.fragment.d(detaching);
            // TODO null out other refs, including component.$$ (but need to
            // preserve final state?)
            $$.on_destroy = $$.fragment = null;
            $$.ctx = [];
        }
    }
    function make_dirty(component, i) {
        if (component.$$.dirty[0] === -1) {
            dirty_components.push(component);
            schedule_update();
            component.$$.dirty.fill(0);
        }
        component.$$.dirty[(i / 31) | 0] |= (1 << (i % 31));
    }
    function init(component, options, instance, create_fragment, not_equal, props, dirty = [-1]) {
        const parent_component = current_component;
        set_current_component(component);
        const prop_values = options.props || {};
        const $$ = component.$$ = {
            fragment: null,
            ctx: null,
            // state
            props,
            update: noop,
            not_equal,
            bound: blank_object(),
            // lifecycle
            on_mount: [],
            on_destroy: [],
            before_update: [],
            after_update: [],
            context: new Map(parent_component ? parent_component.$$.context : []),
            // everything else
            callbacks: blank_object(),
            dirty
        };
        let ready = false;
        $$.ctx = instance
            ? instance(component, prop_values, (i, ret, ...rest) => {
                const value = rest.length ? rest[0] : ret;
                if ($$.ctx && not_equal($$.ctx[i], $$.ctx[i] = value)) {
                    if ($$.bound[i])
                        $$.bound[i](value);
                    if (ready)
                        make_dirty(component, i);
                }
                return ret;
            })
            : [];
        $$.update();
        ready = true;
        run_all($$.before_update);
        // `false` as a special case of no DOM component
        $$.fragment = create_fragment ? create_fragment($$.ctx) : false;
        if (options.target) {
            if (options.hydrate) {
                const nodes = children(options.target);
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.l(nodes);
                nodes.forEach(detach);
            }
            else {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.c();
            }
            if (options.intro)
                transition_in(component.$$.fragment);
            mount_component(component, options.target, options.anchor);
            flush();
        }
        set_current_component(parent_component);
    }
    class SvelteComponent {
        $destroy() {
            destroy_component(this, 1);
            this.$destroy = noop;
        }
        $on(type, callback) {
            const callbacks = (this.$$.callbacks[type] || (this.$$.callbacks[type] = []));
            callbacks.push(callback);
            return () => {
                const index = callbacks.indexOf(callback);
                if (index !== -1)
                    callbacks.splice(index, 1);
            };
        }
        $set() {
            // overridden by instance, if it has props
        }
    }

    function cubicOut(t) {
        const f = t - 1.0;
        return f * f * f + 1.0;
    }

    function fly(node, { delay = 0, duration = 400, easing = cubicOut, x = 0, y = 0, opacity = 0 }) {
        const style = getComputedStyle(node);
        const target_opacity = +style.opacity;
        const transform = style.transform === 'none' ? '' : style.transform;
        const od = target_opacity * (1 - opacity);
        return {
            delay,
            duration,
            easing,
            css: (t, u) => `
			transform: ${transform} translate(${(1 - t) * x}px, ${(1 - t) * y}px);
			opacity: ${target_opacity - (od * u)}`
        };
    }

    /* src/TodoItem.svelte generated by Svelte v3.23.0 */

    function create_fragment(ctx) {
    	let div3;
    	let div1;
    	let input;
    	let t0;
    	let div0;
    	let t1;
    	let div1_transition;
    	let t2;
    	let div2;
    	let current;
    	let mounted;
    	let dispose;

    	return {
    		c() {
    			div3 = element("div");
    			div1 = element("div");
    			input = element("input");
    			t0 = space();
    			div0 = element("div");
    			t1 = text(/*title*/ ctx[1]);
    			t2 = space();
    			div2 = element("div");
    			div2.textContent = "x";
    			attr(input, "type", "checkbox");
    			attr(div0, "class", "todo-item-label svelte-2cvsdl");
    			toggle_class(div0, "completed", /*completed*/ ctx[0]);
    			attr(div1, "class", "todo-item-left svelte-2cvsdl");
    			attr(div2, "class", "remove-item svelte-2cvsdl");
    			attr(div3, "class", "todo-item svelte-2cvsdl");
    		},
    		m(target, anchor) {
    			insert(target, div3, anchor);
    			append(div3, div1);
    			append(div1, input);
    			input.checked = /*completed*/ ctx[0];
    			append(div1, t0);
    			append(div1, div0);
    			append(div0, t1);
    			append(div3, t2);
    			append(div3, div2);
    			current = true;

    			if (!mounted) {
    				dispose = [
    					listen(input, "change", /*input_change_handler*/ ctx[6]),
    					listen(input, "change", /*toggleComplete*/ ctx[3]),
    					listen(div2, "click", /*deleteTodo*/ ctx[2])
    				];

    				mounted = true;
    			}
    		},
    		p(ctx, [dirty]) {
    			if (dirty & /*completed*/ 1) {
    				input.checked = /*completed*/ ctx[0];
    			}

    			if (!current || dirty & /*title*/ 2) set_data(t1, /*title*/ ctx[1]);

    			if (dirty & /*completed*/ 1) {
    				toggle_class(div0, "completed", /*completed*/ ctx[0]);
    			}
    		},
    		i(local) {
    			if (current) return;

    			add_render_callback(() => {
    				if (!div1_transition) div1_transition = create_bidirectional_transition(div1, fly, { y: 20, duration: 300 }, true);
    				div1_transition.run(1);
    			});

    			current = true;
    		},
    		o(local) {
    			if (!div1_transition) div1_transition = create_bidirectional_transition(div1, fly, { y: 20, duration: 300 }, false);
    			div1_transition.run(0);
    			current = false;
    		},
    		d(detaching) {
    			if (detaching) detach(div3);
    			if (detaching && div1_transition) div1_transition.end();
    			mounted = false;
    			run_all(dispose);
    		}
    	};
    }

    function instance($$self, $$props, $$invalidate) {
    	let { id } = $$props;
    	let { title } = $$props;
    	let { completed } = $$props;

    	//min 1:08
    	const dispatch = createEventDispatcher();

    	function deleteTodo() {
    		dispatch("deleteTodo", { id });
    	}

    	function toggleComplete() {
    		dispatch("toggleComplete", { id });
    	}

    	function input_change_handler() {
    		completed = this.checked;
    		$$invalidate(0, completed);
    	}

    	$$self.$set = $$props => {
    		if ("id" in $$props) $$invalidate(4, id = $$props.id);
    		if ("title" in $$props) $$invalidate(1, title = $$props.title);
    		if ("completed" in $$props) $$invalidate(0, completed = $$props.completed);
    	};

    	return [
    		completed,
    		title,
    		deleteTodo,
    		toggleComplete,
    		id,
    		dispatch,
    		input_change_handler
    	];
    }

    class TodoItem extends SvelteComponent {
    	constructor(options) {
    		super();
    		init(this, options, instance, create_fragment, safe_not_equal, { id: 4, title: 1, completed: 0 });
    	}
    }

    /* src/Todos.svelte generated by Svelte v3.23.0 */

    function get_each_context(ctx, list, i) {
    	const child_ctx = ctx.slice();
    	child_ctx[15] = list[i];
    	return child_ctx;
    }

    // (138:0) {#each filteredTodos as todo}
    function create_each_block(ctx) {
    	let div;
    	let current;
    	const todoitem_spread_levels = [/*todo*/ ctx[15]];
    	let todoitem_props = {};

    	for (let i = 0; i < todoitem_spread_levels.length; i += 1) {
    		todoitem_props = assign(todoitem_props, todoitem_spread_levels[i]);
    	}

    	const todoitem = new TodoItem({ props: todoitem_props });
    	todoitem.$on("deleteTodo", /*handleDeleteTodo*/ ctx[8]);
    	todoitem.$on("toggleComplete", /*handleToggleComplete*/ ctx[9]);

    	return {
    		c() {
    			div = element("div");
    			create_component(todoitem.$$.fragment);
    			attr(div, "class", "todo-item");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);
    			mount_component(todoitem, div, null);
    			current = true;
    		},
    		p(ctx, dirty) {
    			const todoitem_changes = (dirty & /*filteredTodos*/ 8)
    			? get_spread_update(todoitem_spread_levels, [get_spread_object(/*todo*/ ctx[15])])
    			: {};

    			todoitem.$set(todoitem_changes);
    		},
    		i(local) {
    			if (current) return;
    			transition_in(todoitem.$$.fragment, local);
    			current = true;
    		},
    		o(local) {
    			transition_out(todoitem.$$.fragment, local);
    			current = false;
    		},
    		d(detaching) {
    			if (detaching) detach(div);
    			destroy_component(todoitem);
    		}
    	};
    }

    function create_fragment$1(ctx) {
    	let div6;
    	let i;
    	let t0;
    	let h2;
    	let t2;
    	let input0;
    	let t3;
    	let t4;
    	let div2;
    	let div0;
    	let label;
    	let input1;
    	let t5;
    	let t6;
    	let div1;
    	let t7;
    	let t8;
    	let t9;
    	let div5;
    	let div3;
    	let button0;
    	let t11;
    	let button1;
    	let t13;
    	let button2;
    	let t15;
    	let div4;
    	let button3;
    	let current;
    	let mounted;
    	let dispose;
    	let each_value = /*filteredTodos*/ ctx[3];
    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block(get_each_context(ctx, each_value, i));
    	}

    	const out = i => transition_out(each_blocks[i], 1, 1, () => {
    		each_blocks[i] = null;
    	});

    	return {
    		c() {
    			div6 = element("div");
    			i = element("i");
    			t0 = space();
    			h2 = element("h2");
    			h2.textContent = "Svelte Todo App";
    			t2 = space();
    			input0 = element("input");
    			t3 = space();

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			t4 = space();
    			div2 = element("div");
    			div0 = element("div");
    			label = element("label");
    			input1 = element("input");
    			t5 = text("Check All");
    			t6 = space();
    			div1 = element("div");
    			t7 = text(/*todosRemaining*/ ctx[2]);
    			t8 = text(" items left");
    			t9 = space();
    			div5 = element("div");
    			div3 = element("div");
    			button0 = element("button");
    			button0.textContent = "All";
    			t11 = space();
    			button1 = element("button");
    			button1.textContent = "Active";
    			t13 = space();
    			button2 = element("button");
    			button2.textContent = "Completed";
    			t15 = space();
    			div4 = element("div");
    			button3 = element("button");
    			button3.textContent = "Clear Completed";
    			attr(i, "class", "fas fa-tasks svelte-f5ro9d");
    			attr(input0, "type", "text");
    			attr(input0, "class", "todo-input svelte-f5ro9d");
    			attr(input0, "placeholder", "Insert todo item...");
    			attr(input1, "class", "inner-container-input svelte-f5ro9d");
    			attr(input1, "type", "checkbox");
    			attr(div2, "class", "inner-container svelte-f5ro9d");
    			attr(button0, "class", "svelte-f5ro9d");
    			toggle_class(button0, "active", /*currentFilter*/ ctx[1] === "all");
    			attr(button1, "class", "svelte-f5ro9d");
    			toggle_class(button1, "active", /*currentFilter*/ ctx[1] === "active");
    			attr(button2, "class", "svelte-f5ro9d");
    			toggle_class(button2, "active", /*currentFilter*/ ctx[1] === "completed");
    			attr(button3, "class", "svelte-f5ro9d");
    			attr(div5, "class", "inner-container svelte-f5ro9d");
    			attr(div6, "class", "container svelte-f5ro9d");
    		},
    		m(target, anchor) {
    			insert(target, div6, anchor);
    			append(div6, i);
    			append(div6, t0);
    			append(div6, h2);
    			append(div6, t2);
    			append(div6, input0);
    			set_input_value(input0, /*newTodoTitle*/ ctx[0]);
    			append(div6, t3);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(div6, null);
    			}

    			append(div6, t4);
    			append(div6, div2);
    			append(div2, div0);
    			append(div0, label);
    			append(label, input1);
    			append(label, t5);
    			append(div2, t6);
    			append(div2, div1);
    			append(div1, t7);
    			append(div1, t8);
    			append(div6, t9);
    			append(div6, div5);
    			append(div5, div3);
    			append(div3, button0);
    			append(div3, t11);
    			append(div3, button1);
    			append(div3, t13);
    			append(div3, button2);
    			append(div5, t15);
    			append(div5, div4);
    			append(div4, button3);
    			current = true;

    			if (!mounted) {
    				dispose = [
    					listen(input0, "input", /*input0_input_handler*/ ctx[11]),
    					listen(input0, "keydown", /*addTodo*/ ctx[4]),
    					listen(input1, "change", /*checkAllTodos*/ ctx[5]),
    					listen(button0, "click", /*click_handler*/ ctx[12]),
    					listen(button1, "click", /*click_handler_1*/ ctx[13]),
    					listen(button2, "click", /*click_handler_2*/ ctx[14]),
    					listen(button3, "click", /*clearCompleted*/ ctx[7])
    				];

    				mounted = true;
    			}
    		},
    		p(ctx, [dirty]) {
    			if (dirty & /*newTodoTitle*/ 1 && input0.value !== /*newTodoTitle*/ ctx[0]) {
    				set_input_value(input0, /*newTodoTitle*/ ctx[0]);
    			}

    			if (dirty & /*filteredTodos, handleDeleteTodo, handleToggleComplete*/ 776) {
    				each_value = /*filteredTodos*/ ctx[3];
    				let i;

    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(child_ctx, dirty);
    						transition_in(each_blocks[i], 1);
    					} else {
    						each_blocks[i] = create_each_block(child_ctx);
    						each_blocks[i].c();
    						transition_in(each_blocks[i], 1);
    						each_blocks[i].m(div6, t4);
    					}
    				}

    				group_outros();

    				for (i = each_value.length; i < each_blocks.length; i += 1) {
    					out(i);
    				}

    				check_outros();
    			}

    			if (!current || dirty & /*todosRemaining*/ 4) set_data(t7, /*todosRemaining*/ ctx[2]);

    			if (dirty & /*currentFilter*/ 2) {
    				toggle_class(button0, "active", /*currentFilter*/ ctx[1] === "all");
    			}

    			if (dirty & /*currentFilter*/ 2) {
    				toggle_class(button1, "active", /*currentFilter*/ ctx[1] === "active");
    			}

    			if (dirty & /*currentFilter*/ 2) {
    				toggle_class(button2, "active", /*currentFilter*/ ctx[1] === "completed");
    			}
    		},
    		i(local) {
    			if (current) return;

    			for (let i = 0; i < each_value.length; i += 1) {
    				transition_in(each_blocks[i]);
    			}

    			current = true;
    		},
    		o(local) {
    			each_blocks = each_blocks.filter(Boolean);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				transition_out(each_blocks[i]);
    			}

    			current = false;
    		},
    		d(detaching) {
    			if (detaching) detach(div6);
    			destroy_each(each_blocks, detaching);
    			mounted = false;
    			run_all(dispose);
    		}
    	};
    }

    let nextId = 4;

    function instance$1($$self, $$props, $$invalidate) {
    	let newTodoTitle = "";
    	let currentFilter = "all";

    	let todos = [
    		{
    			id: 1,
    			title: "my first todo",
    			completed: false
    		},
    		{
    			id: 2,
    			title: "my second todo",
    			completed: false
    		},
    		{
    			id: 3,
    			title: "my third todo",
    			completed: false
    		}
    	];

    	function addTodo(event) {
    		if (event.key === "Enter") {
    			$$invalidate(10, todos = [
    				...todos,
    				{
    					id: nextId,
    					completed: false,
    					title: newTodoTitle
    				}
    			]);
    			$$invalidate(0, newTodoTitle = "");
    		}
    	}

    	function checkAllTodos(event) {
    		todos.forEach(todo => todo.completed = event.target.checked);
    		$$invalidate(10, todos);
    	}

    	function updateFilter(newFilter) {
    		$$invalidate(1, currentFilter = newFilter);
    	}

    	function clearCompleted() {
    		$$invalidate(10, todos = todos.filter(todo => !todo.completed));
    	}

    	function handleDeleteTodo(event) {
    		$$invalidate(10, todos = todos.filter(todo => todo.id !== event.detail.id));
    	}

    	// min 57
    	function handleToggleComplete(event) {
    		const todoIndex = todos.findIndex(todo => todo.id === event.detail.id);

    		const updatedTodo = {
    			...todos[todoIndex],
    			completed: !todos[todoIndex].completed
    		};

    		$$invalidate(10, todos = [...todos.slice(0, todoIndex), updatedTodo, ...todos.slice(todoIndex + 1)]);
    	}

    	function input0_input_handler() {
    		newTodoTitle = this.value;
    		$$invalidate(0, newTodoTitle);
    	}

    	const click_handler = () => updateFilter("all");
    	const click_handler_1 = () => updateFilter("active");
    	const click_handler_2 = () => updateFilter("completed");
    	let todosRemaining;
    	let filteredTodos;

    	$$self.$$.update = () => {
    		if ($$self.$$.dirty & /*currentFilter, todos*/ 1026) {
    			 $$invalidate(3, filteredTodos = currentFilter === "all"
    			? todos
    			: currentFilter === "completed"
    				? todos.filter(todo => todo.completed)
    				: todos.filter(todo => !todo.completed));
    		}

    		if ($$self.$$.dirty & /*filteredTodos*/ 8) {
    			 $$invalidate(2, todosRemaining = filteredTodos.filter(todo => !todo.completed).length);
    		}
    	};

    	return [
    		newTodoTitle,
    		currentFilter,
    		todosRemaining,
    		filteredTodos,
    		addTodo,
    		checkAllTodos,
    		updateFilter,
    		clearCompleted,
    		handleDeleteTodo,
    		handleToggleComplete,
    		todos,
    		input0_input_handler,
    		click_handler,
    		click_handler_1,
    		click_handler_2
    	];
    }

    class Todos extends SvelteComponent {
    	constructor(options) {
    		super();
    		init(this, options, instance$1, create_fragment$1, safe_not_equal, {});
    	}
    }

    /* src/App.svelte generated by Svelte v3.23.0 */

    function create_fragment$2(ctx) {
    	let t0;
    	let div;
    	let current;
    	const todos = new Todos({});

    	return {
    		c() {
    			create_component(todos.$$.fragment);
    			t0 = space();
    			div = element("div");
    			div.innerHTML = `<a href="https://www.youtube.com/watch?v=jmXvpJxwFyc">Credits</a>`;
    			attr(div, "class", "credits svelte-hp9ojb");
    		},
    		m(target, anchor) {
    			mount_component(todos, target, anchor);
    			insert(target, t0, anchor);
    			insert(target, div, anchor);
    			current = true;
    		},
    		p: noop,
    		i(local) {
    			if (current) return;
    			transition_in(todos.$$.fragment, local);
    			current = true;
    		},
    		o(local) {
    			transition_out(todos.$$.fragment, local);
    			current = false;
    		},
    		d(detaching) {
    			destroy_component(todos, detaching);
    			if (detaching) detach(t0);
    			if (detaching) detach(div);
    		}
    	};
    }

    class App extends SvelteComponent {
    	constructor(options) {
    		super();
    		init(this, options, null, create_fragment$2, safe_not_equal, {});
    	}
    }

    const app = new App({
    	target: document.body,

    });

    return app;

}());
//# sourceMappingURL=bundle.js.map
