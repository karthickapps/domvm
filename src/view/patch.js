import { ELEMENT, TEXT, COMMENT, VVIEW, VMODEL } from './VTYPES';
import { isArr, binaryKeySearch } from '../utils';
import { preProc } from './preProc';
import { hydrateBody } from './hydrate';
import { clearChildren } from './dom';
import { syncChildren } from './syncChildren';
import { fireHook } from './hooks';
import { patchAttrs } from './patchAttrs';
import { createView } from './createView';
import { FIXED_BODY, DEEP_REMOVE, KEYED_LIST, LAZY_LIST } from './initElementNode';

function alreadyAdopted(vnode) {
	return vnode.el._node.parent !== vnode.parent;
}

function takeSeqIndex(n, obody, fromIdx) {
	return obody[fromIdx];
}

function findSeqThorough(n, obody, fromIdx) {		// pre-tested isView?
	for (; fromIdx < obody.length; fromIdx++) {
		var o = obody[fromIdx];

		if (o.vm != null) {
			// match by key & viewFn || vm
			if (n.type === VVIEW && o.vm.view === n.view && o.vm.key === n.key || n.type === VMODEL && o.vm === n.vm)
				return o;
		}
		else if (!alreadyAdopted(o) && n.tag === o.tag && n.type === o.type && n.key === o.key && (n.flags & ~DEEP_REMOVE) === (o.flags & ~DEEP_REMOVE))
			return o;
	}

	return null;
}

function findSeqKeyed(n, obody, fromIdx) {
	for (; fromIdx < obody.length; fromIdx++) {
		var o = obody[fromIdx];

		if (o.key === n.key)
			return o;
	}

	return null;
}

// list must be a sorted list of vnodes by key
function findBinKeyed(n, list) {
	var idx = binaryKeySearch(list, n.key);
	return idx > -1 ? list[idx] : null;
}

// have it handle initial hydrate? !donor?
// types (and tags if ELEM) are assumed the same, and donor exists
export function patch(vnode, donor) {
	donor.hooks && fireHook("willRecycle", donor, vnode);

	var el = vnode.el = donor.el;

	var obody = donor.body;
	var nbody = vnode.body;

	el._node = vnode;

	// "" => ""
	if (vnode.type === TEXT && nbody !== obody) {
		el.nodeValue = nbody;
		return;
	}

	if (vnode.attrs != null || donor.attrs != null)
		patchAttrs(vnode, donor, false);

	// patch events

	var oldIsArr = isArr(obody);
	var newIsArr = isArr(nbody)
	var lazyList = (vnode.flags & LAZY_LIST) === LAZY_LIST;

//	var nonEqNewBody = nbody != null && nbody !== obody;

	if (oldIsArr) {
		// [] => []
		if (newIsArr || lazyList)
			patchChildren(vnode, donor);
		// [] => "" | null
		else if (nbody !== obody) {
			if (nbody != null) {
				if (vnode.raw)
					el.innerHTML = nbody;
				else
					el.textContent = nbody;
			}
			else
				clearChildren(donor);
		}
	}
	else {
		// "" | null => []
		if (newIsArr) {
			clearChildren(donor);
			hydrateBody(vnode);
		}
		// "" | null => "" | null
		else if (nbody !== obody) {
			if (vnode.raw)
				el.innerHTML = nbody;
			else if (donor.raw)
				el.textContent = nbody;
			else if (el.firstChild)
				el.firstChild.nodeValue = nbody;
			else
				el.textContent = nbody;
		}
	}

	donor.hooks && fireHook("didRecycle", donor, vnode);
}

function sortByKey(a, b) {
	return a.key > b.key ? 1 : a.key < b.key ? -1 : 0;
}

// larger qtys of KEYED_LIST children will use binary search
//const SEQ_FAILS_MAX = 100;

// TODO: modify vtree matcher to work similar to dom reconciler for keyed from left -> from right -> head/tail -> binary
// fall back to binary if after failing nri - nli > SEQ_FAILS_MAX
// while-advance non-keyed fromIdx
// [] => []
function patchChildren(vnode, donor) {
	var nbody		= vnode.body,
		nlen		= nbody.length,
		obody		= donor.body,
		olen		= obody.length,
		isLazy		= (vnode.flags & LAZY_LIST) === LAZY_LIST,
		isFixed		= (vnode.flags & FIXED_BODY) === FIXED_BODY,
		isKeyed		= (vnode.flags & KEYED_LIST) === KEYED_LIST,
		domSync		= !isFixed && vnode.type === ELEMENT,
		doFind		= true,
		find		= (
			isKeyed ? findSeqKeyed :				// keyed lists/lazyLists (falls back to findBinKeyed when > SEQ_FAILS_MAX)
			isFixed || isLazy ? takeSeqIndex :		// unkeyed lazyLists and FIXED_BODY
			findSeqThorough							// more complex stuff
		);

	if (domSync && nlen === 0) {
		clearChildren(donor);
		if (isLazy)
			vnode.body = [];	// nbody.tpl(all);
		return;
	}

	var donor2,
		node2,
		foundIdx,
		patched = 0,
		everNonseq = false,
		fromIdx = 0;		// first unrecycled node (search head)

	if (isLazy) {
		var fnode2 = {key: null};
		var nbodyNew = Array(nlen);
	}

	for (var i = 0; i < nlen; i++) {
		if (isLazy) {
			var remake = false;
			var diffRes = null;

			if (doFind) {
				if (isKeyed)
					fnode2.key = nbody.key(i);

				donor2 = find(fnode2, obody, fromIdx);
			}

			if (donor2 != null) {
                foundIdx = donor2.idx;
				diffRes = nbody.diff(i, donor2);

				// diff returns same, so cheaply adopt vnode without patching
				if (diffRes === true) {
					node2 = donor2;
					node2.parent = vnode;
					node2.idx = i;
				}
				// diff returns new diffVals, so generate new vnode & patch
				else
					remake = true;
			}
			else
				remake = true;

			if (remake) {
				node2 = nbody.tpl(i);			// what if this is a VVIEW, VMODEL, injected element?
				preProc(node2, vnode, i);

				node2._diff = diffRes != null ? diffRes : nbody.diff(i);

				if (donor2 != null)
					patch(node2, donor2);
			}
			else {
				// TODO: flag tmp FIXED_BODY on unchanged nodes?

				// domSync = true;		if any idx changes or new nodes added/removed
			}

			nbodyNew[i] = node2;
		}
		else {
			var node2 = nbody[i];
			var type2 = node2.type;

			// ELEMENT,TEXT,COMMENT
			if (type2 <= COMMENT) {
				if (donor2 = doFind && find(node2, obody, fromIdx)) {
					patch(node2, donor2);
					foundIdx = donor2.idx;
				}
			}
			else if (type2 === VVIEW) {
				if (donor2 = doFind && find(node2, obody, fromIdx)) {		// update/moveTo
					var vm = donor2.vm._update(node2.data, vnode, i);		// withDOM
					foundIdx = donor2.idx;
				}
				else
					var vm = createView(node2.view, node2.data, node2.key, node2.opts)._redraw(vnode, i, false);	// createView, no dom (will be handled by sync below)

				type2 = vm.node.type;
			}
			else if (type2 === VMODEL) {
				var vm = node2.vm._update(node2.data, vnode, i);
				type2 = vm.node.type;
			}
		}

		// found donor & during a sequential search ...at search head
		if (donor2 != null) {
			if (foundIdx === fromIdx) {
				// advance head
				fromIdx++;
				// if all old vnodes adopted and more exist, stop searching
				if (fromIdx === olen && nlen > olen) {
					// short-circuit find, allow loop just create/init rest
					donor2 = null;
					doFind = false;
				}
			}
			else
				everNonseq = true;

			if (olen > 100 && everNonseq && ++patched % 10 === 0)
				while (fromIdx < olen && alreadyAdopted(obody[fromIdx]))
					fromIdx++;
		}
	}

	// replace List w/ new body
	if (isLazy)
		vnode.body = nbodyNew;

	domSync && syncChildren(vnode, donor);
}