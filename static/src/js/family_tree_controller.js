/** @odoo-module **/

import { KanbanController } from "@web/views/kanban/kanban_controller";
import { useService } from "@web/core/utils/hooks";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { useState, onWillStart, onMounted, onWillUnmount, onPatched, useRef } from "@odoo/owl";

/**
 * Echappe les caractères HTML spéciaux avant injection dans un template
 * string rendu en innerHTML. Les données de contact (nom, fonction, notes,
 * email...) sont éditables par tout utilisateur ayant accès en écriture à
 * res.partner : sans échappement, un nom ou une note contenant du HTML/JS
 * s'exécuterait dans le navigateur de quiconque ouvre l'arbre.
 */
function escapeHtml(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Vocabulaire unique des étiquettes de rôle, strictement identique à celui du
 * champ res.partner.partner_role (models/res_partner.py : PARTNER_ROLE_COLORS
 * et _compute_partner_role). L'arbre généalogique charge ses enregistrements
 * avec un jeu de champs restreint et ne dispose donc pas toujours de
 * partner_role : on rejoue ici la même règle de calcul, à partir de
 * is_company / parent_id / type, pour que l'arbre, ses pop-ups, son sélecteur
 * de parent et sa légende affichent exactement les mêmes libellés que les
 * fiches, listes et kanbans. Toute modification ici doit être répercutée côté
 * Python, et inversement.
 */
export const PARTNER_ROLE_LABELS = {
    societe_mere: "Société mère",
    filiale: "Filiale",
    societe_seule: "Société seule",
    contact_reference: "Contact de référence",
    invoice: "Adresse de facturation",
    delivery: "Adresse de livraison",
    private: "Adresse privée",
    other: "Autre adresse",
    particulier_seul: "Particulier seul",
    auto_entrepreneur: "Auto-entrepreneur",
};

/** Icône et classe CSS associées à chaque rôle (arbre, sélecteur de parent). */
export const PARTNER_ROLE_DISPLAY = {
    societe_mere: { icon: "🏢", cssClass: "type-societe-mere" },
    filiale: { icon: "🏭", cssClass: "type-filiale" },
    societe_seule: { icon: "🏢", cssClass: "type-societe-seule" },
    contact_reference: { icon: "👤", cssClass: "type-contact-reference" },
    invoice: { icon: "📄", cssClass: "type-invoice" },
    delivery: { icon: "🚚", cssClass: "type-delivery" },
    private: { icon: "🏠", cssClass: "type-private" },
    other: { icon: "📍", cssClass: "type-other" },
    particulier_seul: { icon: "🙋", cssClass: "type-particulier-seul" },
    auto_entrepreneur: { icon: "🧾", cssClass: "type-auto-entrepreneur" },
};

/**
 * Rôle d'un partenaire, calculé comme _compute_partner_role côté Python.
 *
 * @param {Object} record enregistrement res.partner (is_company, parent_id,
 *        type, et si connu hasSubsidiaries pour distinguer mère / seule)
 * @param {Boolean} [hasSubsidiaries] vrai si la société possède au moins une
 *        filiale ; à défaut la société est considérée comme société seule.
 * @returns {String} clé de PARTNER_ROLE_LABELS
 */
export function getPartnerRole(record, hasSubsidiaries = false) {
    // partner_role est la source de vérité : dès qu'il est chargé, on l'utilise
    // tel quel. Le calcul de repli ci-dessous ne sert qu'aux rares lectures qui
    // ne demandent pas le champ, et ne peut pas distinguer certains cas
    // (société mère / société seule, auto-entrepreneur) faute des données.
    if (record.partner_role && PARTNER_ROLE_LABELS[record.partner_role]) {
        return record.partner_role;
    }
    if (record.is_company) {
        if (record.parent_id) {
            return "filiale";
        }
        return hasSubsidiaries ? "societe_mere" : "societe_seule";
    }
    if (record.type === "invoice") {
        return "invoice";
    }
    if (record.type === "delivery") {
        return "delivery";
    }
    if (record.type === "private") {
        return "private";
    }
    if (!record.parent_id) {
        return record.vat || record.company_registry
            ? "auto_entrepreneur"
            : "particulier_seul";
    }
    return record.type === "other" ? "other" : "contact_reference";
}

/** Libellé harmonisé du rôle d'un partenaire. */
export function getPartnerRoleLabel(record, hasSubsidiaries = false) {
    return PARTNER_ROLE_LABELS[getPartnerRole(record, hasSubsidiaries)];
}

/**
 * Family Tree Controller
 */
export class FamilyTreeController extends KanbanController {
    static template = "octavize_family_tree.FamilyTreeController";
    
    setup() {
        super.setup();
        
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.notification = useService("notification");
        this.dialogService = useService("dialog");
        
        // Une seule référence sur l'enveloppe commune : les panneaux, eux, sont
        // produits par un t-foreach et se retrouvent par requête DOM.
        this.treeWrapperRef = useRef("treeWrapper");
        
        // Get highlight partner from context
        this.highlightPartnerId = this.props.context?.highlight_partner_id || null;
        
        this.familyTreeState = useState({
            zoomLevel: 100,
            selectedRootId: null,
            // Plusieurs généalogies peuvent être ouvertes côte à côte : on
            // réaffilie d'un groupe à l'autre sans ouvrir deux écrans.
            // selectedRootId reste la racine « courante » (la première ouverte),
            // utilisée par la recherche et le mode devis.
            openRootIds: [],
            treeDataList: [],
            selectedNodeId: null, // Pour la sélection de carte
            rootOptions: [],
            treeData: null,
            expandedSubsidiaries: {},  // Object instead of Set for reactivity
            expandedContacts: {},       // Object instead of Set for reactivity
            isLoading: true,
            activeMenuNodeId: null,
            activeMenuNode: null, // Le node complet pour le menu
            menuPosition: { top: 0, left: 0 }, // Position du menu
            reorganizeMode: false,
            panX: 0, // Position pan horizontale
            panY: 0, // Position pan verticale
            searchQuery: '', // Recherche de contact
            searchResults: [], // Résultats de recherche
            expandLevel: 1, // Niveau de déploiement (1 = racine seule)
            selectedPartnerName: '', // Nom du partenaire sélectionné via recherche
            // Mode fusion
            mergeMode: false,
            selectedForMerge: {}, // { partnerId: true }
            // Mode création devis
            quoteMode: false,
            quoteStep: 0, // 0=client, 1=facturation, 2=livraison
            quoteCustomer: null, // { id, name }
            quoteInvoice: null, // { id, name }
            quoteDelivery: null, // { id, name }
        });
        
        this.recordsById = {};
        this.highlightedIds = new Set();
        
        // Cache pour tous les partenaires (pour la recherche rapide)
        this.allPartnersCache = null;
        this.allPartnersByIdCache = {};
        
        // Visual positions for reorganize mode (not saved to DB)
        this.nodePositions = {};
        this.dragState = {
            isDragging: false,
            nodeId: null,
            startX: 0,
            startY: 0,
            offsetX: 0,
            offsetY: 0,
        };
        
        // Pan/Drag de la vue complète
        this.panState = {
            isPanning: false,
            startX: 0,
            startY: 0,
            startPanX: 0,
            startPanY: 0,
        };
        
        // Bind handlers
        this._onDocumentClick = this._onDocumentClick.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        
        onWillStart(async () => {
            await this.loadFamilyTreeData();
        });
        
        onMounted(() => {
            for (const rootId of this.familyTreeState.openRootIds) {
                this.familyTreeState.expandedSubsidiaries[rootId] = true;
                this.familyTreeState.expandedContacts[rootId] = true;
            }
            if (this.familyTreeState.openRootIds.length) {
                this.updateTreeData();
            }
            document.addEventListener('click', this._onDocumentClick);
            document.addEventListener('mousemove', this._onMouseMove);
            document.addEventListener('mouseup', this._onMouseUp);
            setTimeout(() => this.drawBranches(), 100);
        });
        
        onPatched(() => {
            setTimeout(() => this.drawBranches(), 50);
        });
        
        onWillUnmount(() => {
            document.removeEventListener('click', this._onDocumentClick);
            document.removeEventListener('mousemove', this._onMouseMove);
            document.removeEventListener('mouseup', this._onMouseUp);
        });
    }
    
    /**
     * Draw curved SVG branches between nodes
     */
    drawBranches() {
        const wrapper = this.treeWrapperRef.el;
        if (!wrapper) return;
        // Chaque généalogie ouverte a son propre SVG : les courbes d'un groupe ne
        // doivent jamais traverser le panneau du voisin.
        wrapper.querySelectorAll('.o_family_tree_pane').forEach(pane => {
            const svg = pane.querySelector('.o_tree_svg_container > svg');
            const container = pane.querySelector('.o_family_tree_container');
            if (svg && container) {
                this._drawPaneBranches(svg, container);
            }
        });
    }

    _drawPaneBranches(svg, container) {
        svg.innerHTML = '';
        // getBoundingClientRect renvoie des pixels écran, donc déjà mis à
        // l'échelle par le zoom de l'enveloppe. Le SVG, lui, est à l'intérieur
        // de cette enveloppe et travaille en coordonnées non zoomées : il faut
        // donc diviser les écarts mesurés par l'échelle.
        const scale = (this.familyTreeState.zoomLevel || 100) / 100;
        
        // Only process nodes that have visible children containers
        const nodes = container.querySelectorAll('.o_tree_node[data-id]');
        
        nodes.forEach(treeNode => {
            const nodeColumn = treeNode.querySelector(':scope > .o_tree_node_row > .o_tree_node_column');
            if (!nodeColumn) return;
            
            const parentCard = nodeColumn.querySelector(':scope > .o_partner_card');
            if (!parentCard) return;
            
            // Check if this node has a visible children container
            const childrenContainer = treeNode.querySelector(':scope > .o_tree_node_row > .o_tree_children_right_container');
            if (!childrenContainer) return;
            
            const containerRect = container.getBoundingClientRect();
            const parentRect = parentCard.getBoundingClientRect();
            
            // Draw branches to SUBSIDIARIES (direct children only)
            const subsidiariesContainer = childrenContainer.querySelector(':scope > .o_tree_subsidiaries_right');
            if (subsidiariesContainer) {
                // Only get DIRECT child nodes (not nested)
                const subsidiaryNodes = subsidiariesContainer.querySelectorAll(':scope > .o_tree_node');
                
                if (subsidiaryNodes.length > 0) {
                    // Start from BLUE BUTTON position (70% height on right side)
                    const parentX = (parentRect.right - containerRect.left) / scale;
                    const parentY = (parentRect.top + (parentRect.height * 0.7) - containerRect.top) / scale;
                    
                    subsidiaryNodes.forEach(childNode => {
                        const childCard = childNode.querySelector(':scope > .o_tree_node_row > .o_tree_node_column > .o_partner_card');
                        if (!childCard) return;
                        
                        const childRect = childCard.getBoundingClientRect();
                        // Skip if card is not visible
                        if (childRect.width === 0 || childRect.height === 0) return;
                        
                        const childX = (childRect.left - containerRect.left) / scale;
                        const childY = (childRect.top + childRect.height / 2 - containerRect.top) / scale;
                        
                        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                        const midX = (parentX + childX) / 2;
                        const d = `M ${parentX} ${parentY} C ${midX} ${parentY}, ${midX} ${childY}, ${childX} ${childY}`;
                        path.setAttribute('d', d);
                        path.classList.add('branch-subsidiary');
                        
                        const childId = parseInt(childNode.dataset.id);
                        if (this.highlightedIds.has(childId)) {
                            path.classList.add('branch-highlighted');
                        }
                        
                        svg.appendChild(path);
                    });
                }
            }
            
            // Draw branches to CONTACTS (direct children only)
            const contactsContainer = childrenContainer.querySelector(':scope > .o_tree_contacts_right');
            if (contactsContainer) {
                const contactNodes = contactsContainer.querySelectorAll(':scope > .o_tree_node');
                
                if (contactNodes.length > 0) {
                    const parentX = (parentRect.right - containerRect.left) / scale;
                    const parentY = (parentRect.top + parentRect.height / 2 - containerRect.top) / scale;
                    
                    contactNodes.forEach(childNode => {
                        const childCard = childNode.querySelector(':scope > .o_tree_node_row > .o_tree_node_column > .o_partner_card');
                        if (!childCard) return;
                        
                        const childRect = childCard.getBoundingClientRect();
                        // Skip if card is not visible
                        if (childRect.width === 0 || childRect.height === 0) return;
                        
                        const childX = (childRect.left - containerRect.left) / scale;
                        const childY = (childRect.top + childRect.height / 2 - containerRect.top) / scale;
                        
                        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                        const midX = (parentX + childX) / 2;
                        const d = `M ${parentX} ${parentY} C ${midX} ${parentY}, ${midX} ${childY}, ${childX} ${childY}`;
                        path.setAttribute('d', d);
                        
                        // Color by type
                        if (childCard.classList.contains('type-contact')) {
                            path.classList.add('branch-contact');
                        } else if (childCard.classList.contains('type-invoice')) {
                            path.classList.add('branch-invoice');
                        } else if (childCard.classList.contains('type-delivery')) {
                            path.classList.add('branch-delivery');
                        } else {
                            path.classList.add('branch-other');
                        }
                        
                        const childId = parseInt(childNode.dataset.id);
                        if (this.highlightedIds.has(childId)) {
                            path.classList.add('branch-highlighted');
                        }
                        
                        svg.appendChild(path);
                    });
                }
            }
        });
    }
    
    _onDocumentClick(ev) {
        if (this.familyTreeState.activeMenuNodeId !== null) {
            if (!ev.target.closest('.o_add_menu') && !ev.target.closest('.o_add_child_btn')) {
                this.familyTreeState.activeMenuNodeId = null;
                this.familyTreeState.activeMenuNode = null;
            }
        }
    }
    
    get archInfo() {
        return {
            showEmail: this.props.archInfo?.showEmail !== false,
            showPhone: this.props.archInfo?.showPhone !== false,
            showFunction: this.props.archInfo?.showFunction !== false,
            showAvatar: this.props.archInfo?.showAvatar !== false,
            maxDepth: this.props.archInfo?.maxDepth || 15,
        };
    }

    getContactTypeLabel(record, hasSubsidiaries = false) {
        return getPartnerRoleLabel(record, hasSubsidiaries);
    }

    /**
     * Load family tree data - load ALL companies for selector
     */
    async loadFamilyTreeData() {
        this.familyTreeState.isLoading = true;
        
        try {
            const fieldsToFetch = [
                'id', 'name', 'display_name', 'parent_id', 'child_ids',
                'is_company', 'email', 'phone', 'function', 'image_128',
                'street', 'city', 'country_id', 'type', 'commercial_partner_id',
            'partner_role'
            ];
            
            // Check for affiliate_ids
            try {
                const modelFields = await this.orm.call(
                    'ir.model.fields', 'search_read',
                    [[['model', '=', 'res.partner'], ['name', '=', 'affiliate_ids']]],
                    { fields: ['name'], limit: 1 }
                );
                if (modelFields.length > 0) {
                    fieldsToFetch.push('affiliate_ids');
                    this.hasAffiliateField = true;
                }
            } catch (e) {
                this.hasAffiliateField = false;
            }
            
            // Check if we have a context with a specific partner to show
            const contextRootId = this.props.context?.family_tree_root_id;
            const contextHighlightId = this.props.context?.highlight_partner_id;
            
            // If no context, show empty welcome screen
            if (!contextRootId && !contextHighlightId) {
                this.familyTreeState.isLoading = false;
                this.familyTreeState.treeData = null;
                return;
            }
            
            // Load ALL root contacts (without parent) - companies AND individuals
            const allRoots = await this.orm.searchRead(
                'res.partner',
                [['parent_id', '=', false], ['type', '!=', 'private']],
                fieldsToFetch,
                { order: 'is_company desc, name asc', limit: 500 }
            );
            
            this.recordsById = {};
            for (const record of allRoots) {
                this.recordsById[record.id] = record;
            }
            
            // Set root options to ALL root contacts
            this.familyTreeState.rootOptions = allRoots;
            
            // Select root from context
            let selectedRoot = null;
            
            if (contextRootId) {
                selectedRoot = allRoots.find(r => r.id === contextRootId);
                
                // If root from context is not in the list, load it specifically
                if (!selectedRoot) {
                    const contextRoots = await this.orm.searchRead(
                        'res.partner',
                        [['id', '=', contextRootId]],
                        fieldsToFetch,
                        { limit: 1 }
                    );
                    if (contextRoots.length > 0) {
                        selectedRoot = contextRoots[0];
                        this.recordsById[selectedRoot.id] = selectedRoot;
                        // Add to root options at the beginning
                        this.familyTreeState.rootOptions = [selectedRoot, ...allRoots];
                    }
                }
                
                // Set selected partner name for the badge
                if (selectedRoot) {
                    this.familyTreeState.selectedPartnerName = selectedRoot.display_name;
                }
            }
            
            if (selectedRoot) {
                this._pfSetRoots([selectedRoot.id]);
                this.familyTreeState.expandedSubsidiaries[selectedRoot.id] = true;
                this.familyTreeState.expandedContacts[selectedRoot.id] = true;
                
                // Load children for selected root
                await this.loadChildrenForRoot(selectedRoot.id, fieldsToFetch);
                
                // Calculate highlighted lineage if needed
                if (this.highlightPartnerId) {
                    this.calculateHighlightedLineage();
                }
            }
            
            this.updateTreeData();
            
        } catch (error) {
            console.error("Error loading family tree data:", error);
            this.notification.add("Failed to load family tree data", { type: "danger" });
        }
        
        this.familyTreeState.isLoading = false;
    }

    /**
     * Load all children for a specific root (and recursively their children)
     */
    async loadChildrenForRoot(rootId, fieldsToFetch) {
        const root = this.recordsById[rootId];
        if (!root) return;
        
        const allChildIds = new Set();
        
        if (root.child_ids?.length > 0) {
            root.child_ids.forEach(id => allChildIds.add(id));
        }
        if (root.affiliate_ids?.length > 0) {
            root.affiliate_ids.forEach(id => allChildIds.add(id));
        }
        
        if (allChildIds.size > 0) {
            await this.loadChildrenRecursively([...allChildIds], fieldsToFetch);
        }
    }

    async loadChildrenRecursively(childIds, fieldsToFetch, depth = 0) {
        if (childIds.length === 0 || depth > 20) return;
        
        // Filtrer les IDs déjà chargés pour éviter les boucles infinies
        const idsToLoad = childIds.filter(id => !this.recordsById[id]);
        if (idsToLoad.length === 0) return;
        
        // Charger les enfants
        const children = await this.orm.searchRead(
            'res.partner',
            [['id', 'in', idsToLoad]],
            fieldsToFetch
        );
        
        const newChildIds = new Set();
        
        for (const child of children) {
            this.recordsById[child.id] = child;
            if (child.child_ids?.length > 0) {
                child.child_ids.forEach(id => {
                    if (!this.recordsById[id]) newChildIds.add(id);
                });
            }
            if (child.affiliate_ids?.length > 0) {
                child.affiliate_ids.forEach(id => {
                    if (!this.recordsById[id]) newChildIds.add(id);
                });
            }
        }
        
        if (newChildIds.size > 0) {
            await this.loadChildrenRecursively([...newChildIds], fieldsToFetch, depth + 1);
        }
    }

    /**
     * Calculate which node should be highlighted (only the origin partner)
     */
    calculateHighlightedLineage() {
        this.highlightedIds.clear();
        
        if (!this.highlightPartnerId || !this.recordsById[this.highlightPartnerId]) return;
        
        // Only highlight the origin partner itself
        this.highlightedIds.add(this.highlightPartnerId);
        
        // Expand all ancestors to make the highlighted node visible
        let current = this.recordsById[this.highlightPartnerId];
        while (current?.parent_id) {
            const parentId = current.parent_id[0];
            this.familyTreeState.expandedSubsidiaries[parentId] = true;
            this.familyTreeState.expandedContacts[parentId] = true;
            current = this.recordsById[parentId];
        }
        
        // Also expand the highlighted node if it has children
        const record = this.recordsById[this.highlightPartnerId];
        if (record && ((record.child_ids?.length > 0) || (record.affiliate_ids?.length > 0))) {
            this.familyTreeState.expandedSubsidiaries[this.highlightPartnerId] = true;
            this.familyTreeState.expandedContacts[this.highlightPartnerId] = true;
        }
    }

    addDescendantsToHighlight(partnerId) {
        // Not used anymore - only highlight origin
    }

    /**
     * Check if a node should be highlighted
     */
    isHighlighted(nodeId) {
        return this.highlightedIds.has(nodeId);
    }

    /**
     * Définir les généalogies ouvertes.
     *
     * Toutes les entrées du code qui « changent de racine » passent par ici, de
     * sorte que openRootIds et selectedRootId ne puissent pas diverger.
     *
     * @param {Array<Number>} ids racines à ouvrir
     * @param {Boolean} [append] ajouter aux généalogies déjà ouvertes au lieu de
     *        les remplacer
     */
    _pfSetRoots(ids, append = false) {
        const state = this.familyTreeState;
        const next = append ? [...state.openRootIds] : [];
        for (const id of ids) {
            const rootId = parseInt(id, 10);
            if (rootId && !next.includes(rootId)) {
                next.push(rootId);
            }
        }
        state.openRootIds = next;
        state.selectedRootId = next.length ? next[0] : null;
    }

    updateTreeData() {
        const state = this.familyTreeState;
        if (!this.recordsById) {
            state.treeDataList = [];
            state.treeData = null;
            return;
        }

        const panes = [];
        for (const rootId of state.openRootIds) {
            const rootRecord = this.recordsById[rootId];
            if (!rootRecord) continue;
            panes.push({
                rootId: rootId,
                rootName: rootRecord.display_name || rootRecord.name || '',
                node: this._buildTreeNode(rootRecord, 0),
            });
        }
        state.treeDataList = panes;
        // Conservé pour tout ce qui raisonne encore sur une seule généalogie
        // (écrans d'accueil, mode devis, dessin initial).
        state.treeData = panes.length ? panes[0].node : null;
    }

    _buildTreeNode(record, depth) {
        const children = [];
        const maxDepth = this.archInfo.maxDepth || 15;
        
        if (depth < maxDepth) {
            const allChildIds = new Set();
            
            if (record.child_ids?.length > 0) {
                record.child_ids.forEach(id => allChildIds.add(id));
            }
            if (record.affiliate_ids?.length > 0) {
                record.affiliate_ids.forEach(id => allChildIds.add(id));
            }
            
            for (const childId of allChildIds) {
                const childRecord = this.recordsById[childId];
                if (childRecord) {
                    children.push(this._buildTreeNode(childRecord, depth + 1));
                }
            }
            
            children.sort((a, b) => {
                if (a.record.is_company && !b.record.is_company) return -1;
                if (!a.record.is_company && b.record.is_company) return 1;
                return (a.record.name || '').localeCompare(b.record.name || '');
            });
        }
        
        // Separate children into two groups:
        // - subsidiaryChildren: companies (filiales) -> go BELOW
        // - contactChildren: contacts, addresses -> go to the RIGHT
        const subsidiaryChildren = children.filter(c => c.record.is_company);
        const contactChildren = children.filter(c => !c.record.is_company);
        
        const hasSubsidiaries = subsidiaryChildren.length > 0;
        const hasContacts = contactChildren.length > 0;
        // Pour l'étiquette de rôle uniquement : on regarde les enfants sociétés
        // réellement rattachés, sans dépendre de la profondeur maximale
        // d'affichage (au-delà, "children" est vide et une société mère serait
        // étiquetée "Société seule").
        const hasSubsidiaryChildren = hasSubsidiaries || (record.child_ids || []).some(
            (childId) => this.recordsById[childId]?.is_company
        );
        const hasChildren = children.length > 0;
        
        const isSubsidiariesExpanded = !!this.familyTreeState.expandedSubsidiaries[record.id];
        const isContactsExpanded = !!this.familyTreeState.expandedContacts[record.id];
        
        return {
            id: record.id,
            record: record,
            children: children,
            subsidiaryChildren: hasSubsidiaries && isSubsidiariesExpanded ? subsidiaryChildren : [],
            contactChildren: hasContacts && isContactsExpanded ? contactChildren : [],
            hasChildren: hasChildren,
            hasSubsidiaries: hasSubsidiaries,
            hasContacts: hasContacts,
            isSubsidiariesExpanded: isSubsidiariesExpanded,
            isContactsExpanded: isContactsExpanded,
            subsidiaryCount: subsidiaryChildren.length,
            contactCount: contactChildren.length,
            childCount: children.length,
            depth: depth,
            typeLabel: this.getContactTypeLabel(record, hasSubsidiaryChildren),
            roleKey: getPartnerRole(record, hasSubsidiaryChildren),
            roleClass: PARTNER_ROLE_DISPLAY[getPartnerRole(record, hasSubsidiaryChildren)].cssClass,
            isSubsidiary: record.is_company && !!record.parent_id,
            isHighlighted: this.isHighlighted(record.id),
        };
    }

    openRecord(record) {
        // Ouvrir le formulaire Odoo en mode dialog (popup) pour modification
        this.actionService.doAction({
            type: "ir.actions.act_window",
            name: record.display_name,
            res_model: "res.partner",
            res_id: record.id,
            views: [[false, "form"]],
            view_mode: "form",
            target: "new",  // Ouvre en dialog/popup
        }, {
            onClose: async () => {
                // Rafraîchir l'arbre après fermeture du dialog
                await this.onRefresh();
            }
        });
    }

    /**
     * Open a custom detail dialog with action buttons (kept for reference but not used)
     */
    async openDetailDialog(record) {
        // Fetch full record data
        const fullRecord = await this.orm.searchRead(
            "res.partner",
            [['id', '=', record.id]],
            ['id', 'name', 'display_name', 'is_company', 'parent_id', 'email', 'phone', 'mobile', 
             'street', 'street2', 'city', 'zip', 'country_id', 'function', 'title', 'comment',
             'vat', 'website', 'type', 'image_128', 'child_ids', 'category_id', 'ref', 'lang',
             'partner_role'],
            { limit: 1 }
        );
        
        if (!fullRecord.length) return;
        const data = fullRecord[0];
        
        // Build address string
        let address = '';
        if (data.street) address += data.street;
        if (data.street2) address += (address ? ', ' : '') + data.street2;
        if (data.zip || data.city) {
            address += (address ? '<br>' : '') + (data.zip || '') + ' ' + (data.city || '');
        }
        if (data.country_id) address += (address ? ', ' : '') + data.country_id[1];
        
        // partner_role est lu directement : c'est la source de vérité calculée
        // côté Python (child_ids mélange filiales et adresses, il ne permet pas
        // de distinguer une société mère d'une société seule).
        const roleLabel = PARTNER_ROLE_LABELS[data.partner_role] || getPartnerRoleLabel(data);
        
        const dialogHtml = `
            <div class="partner-detail-dialog">
                <div class="partner-header">
                    <div class="partner-avatar">
                        ${data.image_128
                            ? `<img src="data:image/png;base64,${escapeHtml(data.image_128)}" alt="${escapeHtml(data.name)}"/>`
                            : `<div class="avatar-placeholder">${escapeHtml(this.getInitials(data.name))}</div>`
                        }
                    </div>
                    <div class="partner-title">
                        <h2>${escapeHtml(data.display_name)}</h2>
                        ${data.function ? `<div class="partner-function">${escapeHtml(data.function)}</div>` : ''}
                        ${data.parent_id ? `<div class="partner-company">${escapeHtml(data.parent_id[1])}</div>` : ''}
                        <span class="partner-type-badge ${data.is_company ? 'company' : 'contact'}">${escapeHtml(roleLabel)}</span>
                    </div>
                </div>

                <div class="partner-info-grid">
                    ${data.email ? `
                        <div class="info-item">
                            <i class="fa fa-envelope"></i>
                            <div>
                                <label>Email</label>
                                <a href="mailto:${escapeHtml(data.email)}">${escapeHtml(data.email)}</a>
                            </div>
                        </div>
                    ` : ''}
                    ${data.phone ? `
                        <div class="info-item">
                            <i class="fa fa-phone"></i>
                            <div>
                                <label>Téléphone</label>
                                <a href="tel:${escapeHtml(data.phone)}">${escapeHtml(data.phone)}</a>
                            </div>
                        </div>
                    ` : ''}
                    ${data.mobile ? `
                        <div class="info-item">
                            <i class="fa fa-mobile"></i>
                            <div>
                                <label>Mobile</label>
                                <a href="tel:${escapeHtml(data.mobile)}">${escapeHtml(data.mobile)}</a>
                            </div>
                        </div>
                    ` : ''}
                    ${address ? `
                        <div class="info-item">
                            <i class="fa fa-map-marker"></i>
                            <div>
                                <label>Adresse</label>
                                <span>${escapeHtml(address)}</span>
                            </div>
                        </div>
                    ` : ''}
                    ${data.website ? `
                        <div class="info-item">
                            <i class="fa fa-globe"></i>
                            <div>
                                <label>Site web</label>
                                <a href="${escapeHtml(data.website)}" target="_blank">${escapeHtml(data.website)}</a>
                            </div>
                        </div>
                    ` : ''}
                    ${data.vat ? `
                        <div class="info-item">
                            <i class="fa fa-id-card"></i>
                            <div>
                                <label>N° TVA</label>
                                <span>${escapeHtml(data.vat)}</span>
                            </div>
                        </div>
                    ` : ''}
                    ${data.ref ? `
                        <div class="info-item">
                            <i class="fa fa-tag"></i>
                            <div>
                                <label>Référence</label>
                                <span>${escapeHtml(data.ref)}</span>
                            </div>
                        </div>
                    ` : ''}
                </div>

                ${data.comment ? `
                    <div class="partner-notes">
                        <label><i class="fa fa-sticky-note"></i> Notes</label>
                        <p>${escapeHtml(data.comment)}</p>
                    </div>
                ` : ''}
            </div>
            
            <style>
                .partner-detail-dialog { padding: 24px; }
                .partner-header { display: flex; gap: 20px; margin-bottom: 24px; align-items: center; }
                .partner-avatar img { width: 80px; height: 80px; border-radius: 12px; object-fit: cover; }
                .partner-avatar .avatar-placeholder { width: 80px; height: 80px; border-radius: 12px; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: white; display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 600; }
                .partner-title h2 { margin: 0 0 4px 0; font-size: 22px; color: #1e293b; }
                .partner-function { font-size: 14px; color: #64748b; margin-bottom: 4px; }
                .partner-company { font-size: 14px; color: #3b82f6; font-weight: 500; margin-bottom: 8px; }
                .partner-type-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
                .partner-type-badge.company { background: #dbeafe; color: #1d4ed8; }
                .partner-type-badge.contact { background: #fce7f3; color: #be185d; }
                .partner-info-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
                .info-item { display: flex; gap: 12px; padding: 12px; background: #f8fafc; border-radius: 10px; }
                .info-item i { color: #6366f1; font-size: 16px; margin-top: 2px; }
                .info-item label { display: block; font-size: 12px; color: #64748b; margin-bottom: 2px; }
                .info-item span, .info-item a { font-size: 14px; color: #1e293b; text-decoration: none; }
                .info-item a:hover { color: #6366f1; }
                .partner-notes { margin-top: 20px; padding: 16px; background: #fefce8; border-radius: 10px; border-left: 4px solid #eab308; }
                .partner-notes label { display: block; font-size: 13px; color: #854d0e; font-weight: 600; margin-bottom: 8px; }
                .partner-notes p { margin: 0; font-size: 14px; color: #713f12; white-space: pre-wrap; }
            </style>
        `;
        
        // Create dialog
        const dialog = document.createElement('div');
        dialog.className = 'modal fade show';
        dialog.style.cssText = 'display: block; background: rgba(0,0,0,0.5); position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 10000;';
        dialog.innerHTML = `
            <div class="modal-dialog" style="margin: 40px auto; max-width: 700px;">
                <div class="modal-content" style="border-radius: 16px; box-shadow: 0 25px 80px rgba(0,0,0,0.3); overflow: hidden;">
                    <div class="modal-header" style="border-bottom: 1px solid #e2e8f0; padding: 16px 24px; background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); display: flex; justify-content: space-between; align-items: center;">
                        <h5 class="modal-title" style="font-weight: 700; font-size: 18px; color: #1e293b; margin: 0;">
                            Détail de la fiche
                        </h5>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <button type="button" class="btn-open-full" style="display: flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 8px; border: none; background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color: white; cursor: pointer; font-size: 13px; font-weight: 500;">
                                <i class="fa fa-external-link"></i> Ouvrir fiche
                            </button>
                            <button type="button" class="btn-close" style="background: none; border: none; font-size: 24px; cursor: pointer; color: #94a3b8; line-height: 1;">&times;</button>
                        </div>
                    </div>
                    <div class="modal-body" style="padding: 0; max-height: 70vh; overflow-y: auto;">
                        ${dialogHtml}
                    </div>
                    <div class="modal-footer" style="border-top: 1px solid #e2e8f0; padding: 14px 24px; display: flex; gap: 12px; justify-content: flex-end; background: #f8fafc;">
                        <button type="button" class="btn btn-secondary" style="padding: 10px 20px; border-radius: 10px; border: 2px solid #e2e8f0; background: white; cursor: pointer; font-size: 14px; font-weight: 500; color: #64748b;">Fermer</button>
                        <button type="button" class="btn btn-edit" style="padding: 10px 20px; border-radius: 10px; border: none; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; cursor: pointer; font-size: 14px; font-weight: 600;">
                            <i class="fa fa-pencil"></i> Modifier
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(dialog);
        
        const closeBtn = dialog.querySelector('.btn-close');
        const cancelBtn = dialog.querySelector('.btn-secondary');
        const editBtn = dialog.querySelector('.btn-edit');
        const openFullBtn = dialog.querySelector('.btn-open-full');
        
        const closeDialog = () => {
            dialog.remove();
        };
        
        closeBtn.onclick = closeDialog;
        cancelBtn.onclick = closeDialog;
        dialog.onclick = (e) => { if (e.target === dialog) closeDialog(); };
        
        editBtn.onclick = () => {
            closeDialog();
            // Open standard Odoo form dialog for editing
            this.actionService.doAction({
                type: "ir.actions.act_window",
                name: data.display_name,
                res_model: "res.partner",
                res_id: data.id,
                views: [[false, "form"]],
                view_mode: "form",
                target: "new",
            }, {
                onClose: async () => {
                    await this.onRefresh();
                }
            });
        };
        
        openFullBtn.onclick = () => {
            closeDialog();
            this.onOpenFullRecord(null, { record: data });
        };
    }

    onCardClick(ev, node) {
        // Ne pas réagir si clic sur un bouton
        if (ev.target.closest('.o_expand_toggle') || 
            ev.target.closest('.o_add_child_btn') || 
            ev.target.closest('.o_add_menu') ||
            ev.target.closest('.o_drag_handle') ||
            ev.target.closest('.o_change_parent_btn') ||
            ev.target.closest('.o_open_record_btn') ||
            ev.target.closest('.o_create_quote_btn')) {
            return;
        }
        
        // Si mode devis actif, sélectionner la carte
        if (this.familyTreeState.quoteMode) {
            this.onQuoteSelectCard(node);
            return;
        }
        
        // Ouvrir directement la fiche
        this.openRecord(node.record);
    }

    /**
     * Open the full partner record in current window (not dialog)
     */
    onOpenFullRecord(ev, node) {
        this.actionService.doAction({
            type: "ir.actions.act_window",
            name: node.record.display_name,
            res_model: "res.partner",
            res_id: node.record.id,
            views: [[false, "form"]],
            view_mode: "form",
            target: "current",
        });
    }

    /**
     * Start quote mode from toolbar (without pre-selection)
     */
    onStartQuoteMode() {
        // Désactiver le mode fusion si actif
        if (this.familyTreeState.mergeMode) {
            this.familyTreeState.mergeMode = false;
            this.familyTreeState.selectedForMerge = {};
        }
        
        // Toggle mode devis
        if (this.familyTreeState.quoteMode) {
            this.onCancelQuoteMode();
            return;
        }
        
        // Activer le mode devis
        this.familyTreeState.quoteMode = true;
        this.familyTreeState.quoteStep = 0;
        this.familyTreeState.quoteCustomer = null;
        this.familyTreeState.quoteInvoice = null;
        this.familyTreeState.quoteDelivery = null;
        
        this.notification.add("Mode devis activé - Sélectionnez le client", { type: "info" });
    }

    /**
     * Start quote creation mode - User will select addresses by clicking on cards
     * Intelligent pre-filling based on card type
     */
    onCreateQuote(ev, node) {
        // Désactiver le mode fusion si actif
        if (this.familyTreeState.mergeMode) {
            this.familyTreeState.mergeMode = false;
            this.familyTreeState.selectedForMerge = {};
        }
        
        // Activer le mode devis et réinitialiser
        this.familyTreeState.quoteMode = true;
        this.familyTreeState.quoteCustomer = null;
        this.familyTreeState.quoteInvoice = null;
        this.familyTreeState.quoteDelivery = null;
        
        const selection = {
            id: node.record.id,
            name: node.record.display_name,
            type: node.record.is_company ? 'company' : (node.record.type || 'contact')
        };
        
        const recordType = node.record.type || 'contact';
        
        // Pré-remplir intelligemment selon le type de carte cliquée
        if (recordType === 'invoice') {
            // Adresse de facturation → mettre directement dans facturation
            this.familyTreeState.quoteInvoice = selection;
            this.notification.add("Adresse de facturation sélectionnée - Sélectionnez le client", { type: "info" });
        } else if (recordType === 'delivery') {
            // Adresse de livraison → mettre directement dans livraison
            this.familyTreeState.quoteDelivery = selection;
            this.notification.add("Adresse de livraison sélectionnée - Sélectionnez le client", { type: "info" });
        } else {
            // Société ou Contact → mettre dans client
            this.familyTreeState.quoteCustomer = selection;
            this.notification.add("Client sélectionné - Sélectionnez l'adresse de facturation", { type: "info" });
        }
        
        // Calculer l'étape courante (première case vide)
        this._updateQuoteStep();
    }
    
    /**
     * Calculate and update the current quote step based on filled fields
     */
    _updateQuoteStep() {
        if (!this.familyTreeState.quoteCustomer) {
            this.familyTreeState.quoteStep = 0;
        } else if (!this.familyTreeState.quoteInvoice) {
            this.familyTreeState.quoteStep = 1;
        } else if (!this.familyTreeState.quoteDelivery) {
            this.familyTreeState.quoteStep = 2;
        } else {
            // Tout est rempli
            this.familyTreeState.quoteStep = 2;
        }
    }
    
    /**
     * Get notification message based on current step
     */
    _getQuoteStepMessage() {
        const step = this.familyTreeState.quoteStep;
        if (step === 0) {
            return "Sélectionnez le client";
        } else if (step === 1) {
            return "Sélectionnez l'adresse de facturation";
        } else if (step === 2) {
            if (this.familyTreeState.quoteDelivery) {
                return "Cliquez sur 'Créer le devis' pour confirmer";
            }
            return "Sélectionnez l'adresse de livraison";
        }
        return "";
    }
    
    /**
     * Handle card click in quote mode
     */
    onQuoteSelectCard(node) {
        const selection = {
            id: node.record.id,
            name: node.record.display_name,
            type: node.record.is_company ? 'company' : (node.record.type || 'contact')
        };
        
        const recordType = node.record.type || 'contact';
        
        // Logique intelligente: si on clique sur un type spécifique d'adresse,
        // la mettre automatiquement dans le bon champ (même si pas l'étape courante)
        if (recordType === 'invoice') {
            this.familyTreeState.quoteInvoice = selection;
            this.notification.add("Adresse de facturation sélectionnée", { type: "success" });
            this._updateQuoteStep();
            this.notification.add(this._getQuoteStepMessage(), { type: "info" });
            return;
        }
        
        if (recordType === 'delivery') {
            this.familyTreeState.quoteDelivery = selection;
            this.notification.add("Adresse de livraison sélectionnée", { type: "success" });
            this._updateQuoteStep();
            if (this.familyTreeState.quoteCustomer) {
                this.notification.add("Cliquez sur 'Créer le devis' pour confirmer", { type: "success" });
            } else {
                this.notification.add(this._getQuoteStepMessage(), { type: "info" });
            }
            return;
        }
        
        // Pour les sociétés et contacts, remplir la prochaine case vide
        const step = this.familyTreeState.quoteStep;
        
        if (step === 0) {
            // Sélection client
            this.familyTreeState.quoteCustomer = selection;
            this._updateQuoteStep();
            this.notification.add("Client sélectionné", { type: "success" });
            this.notification.add(this._getQuoteStepMessage(), { type: "info" });
        } else if (step === 1) {
            // Sélection facturation
            this.familyTreeState.quoteInvoice = selection;
            this._updateQuoteStep();
            this.notification.add("Adresse de facturation sélectionnée", { type: "success" });
            this.notification.add(this._getQuoteStepMessage(), { type: "info" });
        } else if (step === 2) {
            // Sélection livraison
            this.familyTreeState.quoteDelivery = selection;
            this.notification.add("Adresse de livraison sélectionnée - Cliquez sur 'Créer le devis' pour confirmer", { type: "success" });
        }
    }
    
    /**
     * Cancel quote mode
     */
    onCancelQuoteMode() {
        this.familyTreeState.quoteMode = false;
        this.familyTreeState.quoteStep = 0;
        this.familyTreeState.quoteCustomer = null;
        this.familyTreeState.quoteInvoice = null;
        this.familyTreeState.quoteDelivery = null;
    }
    
    /**
     * Clear a specific quote selection
     */
    onClearQuoteSelection(type) {
        if (type === 'customer') {
            this.familyTreeState.quoteCustomer = null;
        } else if (type === 'invoice') {
            this.familyTreeState.quoteInvoice = null;
        } else if (type === 'delivery') {
            this.familyTreeState.quoteDelivery = null;
        }
        // Recalculer l'étape courante
        this._updateQuoteStep();
    }
    
    /**
     * Create the quotation with selected addresses
     */
    onConfirmQuote() {
        const customer = this.familyTreeState.quoteCustomer;
        const invoice = this.familyTreeState.quoteInvoice;
        const delivery = this.familyTreeState.quoteDelivery;
        
        if (!customer) {
            this.notification.add("Veuillez sélectionner un client", { type: "warning" });
            return;
        }
        
        // Utiliser le client par défaut si pas d'adresse sélectionnée
        const customerId = customer.id;
        const invoiceId = invoice ? invoice.id : customer.id;
        const deliveryId = delivery ? delivery.id : customer.id;
        
        // Reset quote mode
        this.onCancelQuoteMode();
        
        // Ouvrir le module vente avec les bonnes adresses
        this.actionService.doAction({
            type: "ir.actions.act_window",
            name: "Nouveau devis",
            res_model: "sale.order",
            views: [[false, "form"]],
            view_mode: "form",
            target: "current",
            context: {
                default_partner_id: customerId,
                default_partner_invoice_id: invoiceId,
                default_partner_shipping_id: deliveryId,
            },
        });
    }

    /**
     * Create a new contact from the toolbar using wizard
     */
    async onCreateContact() {
        try {
            // Create wizard record
            const wizardId = await this.orm.create('partner.create.contact.wizard', [{}]);
            
            const action = await this.actionService.doAction({
                type: "ir.actions.act_window",
                name: "Nouveau contact",
                res_model: "partner.create.contact.wizard",
                res_id: wizardId,
                views: [[false, "form"]],
                view_mode: "form",
                target: "new",
            });
        } catch (error) {
            console.error("Error opening create contact wizard:", error);
            // Fallback to simple form
            await this.actionService.doAction({
                type: "ir.actions.act_window",
                name: "Nouveau contact",
                res_model: "res.partner",
                views: [[false, "form"]],
                view_mode: "form",
                target: "new",
                context: {
                    default_is_company: false,
                },
            });
        }
    }

    onAddChildClick(ev, node) {
        ev.preventDefault();
        ev.stopPropagation();
        
        if (this.familyTreeState.activeMenuNodeId === node.id) {
            this.familyTreeState.activeMenuNodeId = null;
            this.familyTreeState.activeMenuNode = null;
            return;
        }
        
        // Calculer la position IMMÉDIATEMENT avant de changer le state
        const btn = ev.target.closest('.o_add_child_btn');
        const btnRect = btn.getBoundingClientRect();
        
        // Position initiale
        let top = btnRect.bottom + 5;
        let left = btnRect.left - 80;
        
        // Dimensions viewport
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // Estimation taille menu (200x180 environ)
        const menuWidth = 220;
        const menuHeight = 200;
        
        // Ajustement horizontal
        if (left + menuWidth > viewportWidth - 20) {
            left = viewportWidth - menuWidth - 20;
        }
        if (left < 20) {
            left = 20;
        }
        
        // Ajustement vertical
        if (top + menuHeight > viewportHeight - 20) {
            top = btnRect.top - menuHeight - 5;
            if (top < 20) {
                top = 20;
            }
        }
        
        // Stocker tout dans le state
        this.familyTreeState.activeMenuNodeId = node.id;
        this.familyTreeState.activeMenuNode = node;
        this.familyTreeState.menuPosition = { top, left };
    }

    async onCreateChild(node, type) {
        this.familyTreeState.activeMenuNodeId = null;
        this.familyTreeState.activeMenuNode = null;
        
        const context = {
            default_parent_id: node.record.id,
            default_type: type === 'subsidiary' ? 'other' : type,
            default_is_company: type === 'subsidiary',
        };
        
        await this.actionService.doAction({
            type: "ir.actions.act_window",
            name: "Nouveau contact",
            res_model: "res.partner",
            views: [[false, "form"]],
            target: "new",
            context: context,
        }, {
            onClose: async () => {
                await this.onRefresh();
            }
        });
    }

    /**
     * Open dialog to change parent - Collapsible tree explorer style
     */
    async onChangeParent(ev, node) {
        ev.preventDefault();
        ev.stopPropagation();
        
        // Rechercher tous les contacts avec leurs parents
        const allPartners = await this.orm.searchRead(
            'res.partner',
            [['id', '!=', node.record.id]],
            ['id', 'display_name', 'name', 'is_company', 'type', 'parent_id', 'partner_role'],
            { order: 'is_company desc, name asc', limit: 1000 }
        );
        
        // Construire un index par ID
        const partnersById = {};
        allPartners.forEach(p => partnersById[p.id] = p);
        
        // Fonction pour obtenir l'icône et le label du type
        const hasSubsidiariesById = {};
        allPartners.forEach(p => {
            if (p.is_company && p.parent_id) {
                hasSubsidiariesById[p.parent_id[0]] = true;
            }
        });
        const getTypeInfo = (partner) => {
            const role = getPartnerRole(partner, !!hasSubsidiariesById[partner.id]);
            return { ...PARTNER_ROLE_DISPLAY[role], label: PARTNER_ROLE_LABELS[role] };
        };
        
        // Construire l'arbre hiérarchique
        const rootPartners = allPartners.filter(p => !p.parent_id || !partnersById[p.parent_id[0]]);
        const childrenByParent = {};
        
        allPartners.forEach(p => {
            if (p.parent_id && partnersById[p.parent_id[0]]) {
                const parentId = p.parent_id[0];
                if (!childrenByParent[parentId]) childrenByParent[parentId] = [];
                childrenByParent[parentId].push(p);
            }
        });
        
        // Générer le chemin complet d'un partner
        const getFullPath = (partner) => {
            const path = [partner.display_name];
            let current = partner;
            while (current.parent_id && partnersById[current.parent_id[0]]) {
                current = partnersById[current.parent_id[0]];
                path.unshift(current.display_name);
            }
            return path.join(' → ');
        };
        
        // Générer le HTML de l'arbre dépliable
        const buildTreeHtml = (partners, level = 0) => {
            let html = '';
            partners.forEach((p) => {
                const typeInfo = getTypeInfo(p);
                const children = childrenByParent[p.id] || [];
                const hasChildren = children.length > 0;
                const displayName = p.name || p.display_name;
                const fullPath = getFullPath(p);
                const indent = level * 28;
                
                html += `
                    <div class="tree-item" data-id="${p.id}" data-search="${escapeHtml(fullPath.toLowerCase())} ${escapeHtml(typeInfo.label.toLowerCase())}" data-level="${level}">
                        <div class="tree-item-row" style="padding-left: ${indent + 12}px;" data-id="${p.id}">
                            ${hasChildren ?
                                `<span class="tree-toggle" data-id="${p.id}">
                                    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                                        <path d="M6 4l8 6-8 6V4z"/>
                                    </svg>
                                </span>` :
                                `<span class="tree-toggle-placeholder"></span>`
                            }
                            <span class="tree-icon">${typeInfo.icon}</span>
                            <span class="tree-name">${escapeHtml(displayName)}</span>
                            <span class="tree-type ${typeInfo.cssClass}">${escapeHtml(typeInfo.label)}</span>
                        </div>
                        ${hasChildren ? `<div class="tree-children" data-parent="${p.id}" style="display: none;">${buildTreeHtml(children, level + 1)}</div>` : ''}
                    </div>
                `;
            });
            return html;
        };
        
        const treeHtml = buildTreeHtml(rootPartners);
        
        const currentParentName = node.record.parent_id ? node.record.parent_id[1] : 'Aucun';
        
        const dialogHtml = `
            <div class="parent-selector-dialog">
                <div class="info-box">
                    <div class="info-contact">
                        <strong>Contact :</strong> ${escapeHtml(node.record.display_name)}
                    </div>
                    <div class="info-parent">
                        <strong>Parent actuel :</strong> ${escapeHtml(currentParentName)}
                    </div>
                </div>
                
                <label class="field-label">Sélectionner le nouveau parent :</label>
                
                <input type="text" id="parentSearchInput" 
                       placeholder="🔍 Rechercher un contact ou une société..." 
                       class="search-input"/>
                
                <div class="tree-container" id="treeContainer">
                    <div class="tree-item tree-item-root" data-id="">
                        <div class="tree-item-row selected" data-id="">
                            <span class="tree-toggle-placeholder"></span>
                            <span class="tree-icon">🚫</span>
                            <span class="tree-name">Aucun parent</span>
                            <span class="tree-type type-racine">Contact racine</span>
                        </div>
                    </div>
                    ${treeHtml}
                </div>
                
                <div class="search-results-container" id="searchResultsContainer" style="display: none;">
                    <div class="search-results-header">Résultats de recherche :</div>
                    <div class="search-results" id="searchResults"></div>
                </div>
                
                <div class="legend">
                    <span>🏢 Société mère / seule</span>
                    <span>🏭 Filiale</span>
                    <span>👤 Contact de référence</span>
                    <span>🙋 Particulier seul</span>
                    <span>📄 Adresse de facturation</span>
                    <span>🚚 Adresse de livraison</span>
                </div>
            </div>
            
            <style>
                .parent-selector-dialog { padding: 20px; }
                .info-box { margin-bottom: 16px; padding: 14px 16px; background: #f8fafc; border-radius: 10px; border-left: 4px solid #6366f1; }
                .info-contact { font-size: 15px; color: #334155; margin-bottom: 4px; }
                .info-parent { font-size: 14px; color: #64748b; }
                .field-label { display: block; margin-bottom: 10px; font-weight: 600; font-size: 15px; color: #1e293b; }
                .search-input { width: 100%; padding: 12px 16px; border: 2px solid #e2e8f0; border-radius: 10px; font-size: 15px; margin-bottom: 12px; outline: none; box-sizing: border-box; }
                .search-input:focus { border-color: #6366f1; }
                
                .tree-container { border: 2px solid #e2e8f0; border-radius: 10px; max-height: 380px; overflow-y: auto; background: white; }
                .tree-item { }
                .tree-item-row { display: flex; align-items: center; padding: 10px 14px; cursor: pointer; transition: background 0.15s; gap: 10px; }
                .tree-item-row:hover { background: #f1f5f9; }
                .tree-item-row.selected { background: #eef2ff; border-left: 4px solid #6366f1; }
                
                .tree-toggle { 
                    width: 22px; 
                    height: 22px; 
                    display: flex; 
                    align-items: center; 
                    justify-content: center;
                    color: #6366f1; 
                    cursor: pointer; 
                    user-select: none; 
                    border-radius: 5px;
                    background: #eef2ff;
                    transition: all 0.2s;
                }
                .tree-toggle:hover { background: #6366f1; color: white; }
                .tree-toggle svg { transition: transform 0.2s; }
                .tree-toggle.expanded svg { transform: rotate(90deg); }
                .tree-toggle-placeholder { width: 22px; height: 22px; }
                
                .tree-icon { font-size: 20px; }
                .tree-name { flex: 1; font-size: 14px; font-weight: 500; color: #1e293b; }
                .tree-type { font-size: 11px; padding: 3px 8px; border-radius: 5px; font-weight: 600; }
                .type-societe { background: #dbeafe; color: #1d4ed8; }
                .type-filiale { background: #ede9fe; color: #7c3aed; }
                .type-contact { background: #fce7f3; color: #be185d; }
                .type-facturation { background: #fef3c7; color: #d97706; }
                .type-livraison { background: #d1fae5; color: #059669; }
                .type-privee { background: #e0e7ff; color: #4338ca; }
                .type-autre { background: #f1f5f9; color: #475569; }
                .type-racine { background: #fee2e2; color: #dc2626; }
                
                .tree-children { }
                
                .search-results-container { border: 2px solid #e2e8f0; border-radius: 10px; max-height: 380px; overflow-y: auto; background: white; }
                .search-results-header { padding: 10px 16px; background: #f8fafc; font-weight: 600; font-size: 13px; color: #64748b; border-bottom: 1px solid #e2e8f0; }
                .search-results { }
                .search-result-item { display: flex; flex-direction: column; padding: 10px 16px; cursor: pointer; border-bottom: 1px solid #f1f5f9; }
                .search-result-item:hover { background: #f8fafc; }
                .search-result-item.selected { background: #eef2ff; border-left: 4px solid #6366f1; }
                .search-result-name { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 500; color: #1e293b; }
                .search-result-path { font-size: 12px; color: #94a3b8; margin-top: 4px; padding-left: 28px; }
                
                .legend { margin-top: 14px; font-size: 12px; color: #64748b; display: flex; flex-wrap: wrap; gap: 14px; }
            </style>
        `;
        
        // Créer une map pour accès rapide
        const allPartnersMap = {};
        allPartners.forEach(p => allPartnersMap[p.id] = { ...p, fullPath: getFullPath(p), typeInfo: getTypeInfo(p) });
        
        // Dialog
        const confirmed = await new Promise((resolve) => {
            const dialog = document.createElement('div');
            dialog.className = 'modal fade show';
            dialog.style.cssText = 'display: block; background: rgba(0,0,0,0.5); position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 10000;';
            dialog.innerHTML = `
                <div class="modal-dialog" style="margin: 30px auto; max-width: 900px;">
                    <div class="modal-content" style="border-radius: 16px; box-shadow: 0 25px 80px rgba(0,0,0,0.3); overflow: hidden;">
                        <div class="modal-header" style="border-bottom: 1px solid #e2e8f0; padding: 16px 24px; background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);">
                            <h5 class="modal-title" style="font-weight: 700; font-size: 20px; color: #1e293b; display: flex; align-items: center; gap: 10px;">
                                <span style="font-size: 24px;">🔀</span> Réassigner le parent
                            </h5>
                            <button type="button" class="btn-close" style="background: none; border: none; font-size: 28px; cursor: pointer; color: #94a3b8; line-height: 1;">&times;</button>
                        </div>
                        <div class="modal-body" style="padding: 0; max-height: 75vh; overflow-y: auto;">
                            ${dialogHtml}
                        </div>
                        <div class="modal-footer" style="border-top: 1px solid #e2e8f0; padding: 14px 24px; display: flex; gap: 12px; justify-content: flex-end; background: #f8fafc;">
                            <button type="button" class="btn btn-secondary" style="padding: 10px 24px; border-radius: 10px; border: 2px solid #e2e8f0; background: white; cursor: pointer; font-size: 15px; font-weight: 500; color: #64748b;">Annuler</button>
                            <button type="button" class="btn btn-primary" style="padding: 10px 28px; border-radius: 10px; border: none; background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color: white; cursor: pointer; font-size: 15px; font-weight: 600; box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);">Confirmer</button>
                        </div>
                    </div>
                </div>
            `;
            
            document.body.appendChild(dialog);
            
            let selectedId = '';
            
            const closeBtn = dialog.querySelector('.btn-close');
            const cancelBtn = dialog.querySelector('.btn-secondary');
            const confirmBtn = dialog.querySelector('.btn-primary');
            const searchInput = dialog.querySelector('#parentSearchInput');
            const treeContainer = dialog.querySelector('#treeContainer');
            const searchResultsContainer = dialog.querySelector('#searchResultsContainer');
            const searchResults = dialog.querySelector('#searchResults');
            
            // Gestion des toggles (déplier/replier)
            treeContainer.addEventListener('click', (e) => {
                const toggle = e.target.closest('.tree-toggle');
                if (toggle) {
                    e.stopPropagation();
                    const id = toggle.dataset.id;
                    const children = treeContainer.querySelector(`.tree-children[data-parent="${id}"]`);
                    if (children) {
                        const isExpanded = children.style.display !== 'none';
                        children.style.display = isExpanded ? 'none' : 'block';
                        toggle.classList.toggle('expanded', !isExpanded);
                    }
                    return;
                }
                
                // Sélection d'un item
                const row = e.target.closest('.tree-item-row');
                if (row) {
                    treeContainer.querySelectorAll('.tree-item-row').forEach(r => r.classList.remove('selected'));
                    row.classList.add('selected');
                    selectedId = row.dataset.id;
                }
            });
            
            // Recherche
            searchInput.oninput = () => {
                const query = searchInput.value.toLowerCase().trim();
                
                if (query.length < 2) {
                    treeContainer.style.display = 'block';
                    searchResultsContainer.style.display = 'none';
                    return;
                }
                
                // Filtrer et afficher les résultats
                const results = allPartners.filter(p => {
                    const searchStr = `${p.display_name} ${allPartnersMap[p.id].typeInfo.label} ${allPartnersMap[p.id].fullPath}`.toLowerCase();
                    return searchStr.includes(query);
                });
                
                if (results.length > 0) {
                    treeContainer.style.display = 'none';
                    searchResultsContainer.style.display = 'block';
                    
                    searchResults.innerHTML = results.map(p => {
                        const info = allPartnersMap[p.id];
                        return `
                            <div class="search-result-item ${selectedId === String(p.id) ? 'selected' : ''}" data-id="${p.id}">
                                <div class="search-result-name">
                                    <span>${info.typeInfo.icon}</span>
                                    <span>${escapeHtml(p.display_name)}</span>
                                    <span class="tree-type ${info.typeInfo.cssClass}">${escapeHtml(info.typeInfo.label)}</span>
                                </div>
                                <div class="search-result-path">📍 ${escapeHtml(info.fullPath)}</div>
                            </div>
                        `;
                    }).join('');
                    
                    // Clic sur résultat
                    searchResults.querySelectorAll('.search-result-item').forEach(item => {
                        item.onclick = () => {
                            searchResults.querySelectorAll('.search-result-item').forEach(i => i.classList.remove('selected'));
                            item.classList.add('selected');
                            selectedId = item.dataset.id;
                        };
                    });
                } else {
                    searchResults.innerHTML = '<div style="padding: 20px; text-align: center; color: #94a3b8;">Aucun résultat</div>';
                }
            };
            
            const close = (result) => {
                document.body.removeChild(dialog);
                resolve(result ? selectedId : null);
            };
            
            closeBtn.onclick = () => close(false);
            cancelBtn.onclick = () => close(false);
            confirmBtn.onclick = () => close(true);
            dialog.onclick = (e) => { if (e.target === dialog) close(false); };
            
            setTimeout(() => searchInput.focus(), 100);
        });
        
        if (confirmed !== null) {
            const newParentId = confirmed === '' ? false : parseInt(confirmed);
            await this.orm.write('res.partner', [node.record.id], {
                parent_id: newParentId,
            });
            await this.onRefresh();
            this.notification.add(`Parent modifié avec succès`, { type: "success" });
        }
    }

    onToggleExpandSubsidiaries(nodeId) {
        if (this.familyTreeState.expandedSubsidiaries[nodeId]) {
            delete this.familyTreeState.expandedSubsidiaries[nodeId];
        } else {
            this.familyTreeState.expandedSubsidiaries[nodeId] = true;
        }
        this.updateTreeData();
        this.recalculateExpandLevel();
    }

    onToggleExpandContacts(nodeId) {
        if (this.familyTreeState.expandedContacts[nodeId]) {
            delete this.familyTreeState.expandedContacts[nodeId];
        } else {
            this.familyTreeState.expandedContacts[nodeId] = true;
        }
        this.updateTreeData();
        this.recalculateExpandLevel();
    }
    
    /**
     * Recalculate the expand level based on current expanded state
     */
    recalculateExpandLevel() {
        const rootIds = this.familyTreeState.openRootIds;
        if (!rootIds.length) {
            this.familyTreeState.expandLevel = 0;
            return;
        }
        
        // BFS to find max expanded depth, sur toutes les généalogies ouvertes
        let maxDepth = 0;
        let queue = rootIds.map(id => ({ id: id, depth: 0 }));
        
        while (queue.length > 0) {
            const { id, depth } = queue.shift();
            
            // Check if this node is expanded
            const isExpanded = this.familyTreeState.expandedSubsidiaries[id] || 
                               this.familyTreeState.expandedContacts[id];
            
            if (isExpanded) {
                maxDepth = Math.max(maxDepth, depth + 1);
                
                // Add children to queue
                const record = this.recordsById[id];
                if (record) {
                    if (record.child_ids) {
                        record.child_ids.forEach(childId => {
                            if (this.recordsById[childId]) {
                                queue.push({ id: childId, depth: depth + 1 });
                            }
                        });
                    }
                    if (record.affiliate_ids) {
                        record.affiliate_ids.forEach(childId => {
                            if (this.recordsById[childId]) {
                                queue.push({ id: childId, depth: depth + 1 });
                            }
                        });
                    }
                }
            }
        }
        
        this.familyTreeState.expandLevel = maxDepth;
    }

    async onRootChange(ev) {
        const rootId = parseInt(ev.target.value, 10);
        this._pfSetRoots([rootId]);
        this.familyTreeState.expandedSubsidiaries = {};
        this.familyTreeState.expandedContacts = {};
        this.familyTreeState.expandedSubsidiaries[rootId] = true;
        this.familyTreeState.expandedContacts[rootId] = true;
        this.familyTreeState.expandLevel = 1; // Reset to level 1
        
        // Load children for new root
        const fieldsToFetch = [
            'id', 'name', 'display_name', 'parent_id', 'child_ids',
            'is_company', 'email', 'phone', 'function', 'image_128',
            'street', 'city', 'country_id', 'type', 'commercial_partner_id',
            'partner_role'
        ];
        if (this.hasAffiliateField) fieldsToFetch.push('affiliate_ids');
        
        await this.loadChildrenForRoot(rootId, fieldsToFetch);
        this.updateTreeData();
    }

    /**
     * Expand one level more
     */
    onExpandOneLevel() {
        this.familyTreeState.expandLevel = Math.min(this.familyTreeState.expandLevel + 1, 10);
        this.applyExpandLevel();
    }
    
    /**
     * Collapse one level
     */
    onCollapseOneLevel() {
        this.familyTreeState.expandLevel = Math.max(this.familyTreeState.expandLevel - 1, 0);
        this.applyExpandLevel();
    }
    
    /**
     * Apply the current expand level to all nodes
     * Uses BFS (breadth-first search) from root to expand by level
     */
    applyExpandLevel() {
        // Reset all expansions
        this.familyTreeState.expandedSubsidiaries = {};
        this.familyTreeState.expandedContacts = {};
        
        // If level is 0, show only root (no children expanded)
        if (this.familyTreeState.expandLevel === 0) {
            this.updateTreeData();
            return;
        }
        
        const rootIds = this.familyTreeState.openRootIds.filter(id => this.recordsById[id]);
        if (!rootIds.length) {
            this.updateTreeData();
            return;
        }
        
        // BFS to expand nodes level by level, sur toutes les généalogies ouvertes
        let currentLevel = [...rootIds];
        let currentDepth = 0;
        
        while (currentLevel.length > 0 && currentDepth < this.familyTreeState.expandLevel) {
            const nextLevel = [];
            
            for (const nodeId of currentLevel) {
                // Expand this node
                this.familyTreeState.expandedSubsidiaries[nodeId] = true;
                this.familyTreeState.expandedContacts[nodeId] = true;
                
                // Collect children for next level
                const record = this.recordsById[nodeId];
                if (record) {
                    if (record.child_ids) {
                        record.child_ids.forEach(childId => {
                            if (this.recordsById[childId]) {
                                nextLevel.push(childId);
                            }
                        });
                    }
                    if (record.affiliate_ids) {
                        record.affiliate_ids.forEach(childId => {
                            if (this.recordsById[childId]) {
                                nextLevel.push(childId);
                            }
                        });
                    }
                }
            }
            
            currentLevel = nextLevel;
            currentDepth++;
        }
        
        this.updateTreeData();
    }

    onExpandAll() {
        this.familyTreeState.expandLevel = 10;
        if (!this.recordsById) return;
        for (const id in this.recordsById) {
            const record = this.recordsById[id];
            const hasChildren = (record.child_ids?.length > 0) || (record.affiliate_ids?.length > 0);
            if (hasChildren) {
                this.familyTreeState.expandedSubsidiaries[parseInt(id)] = true;
                this.familyTreeState.expandedContacts[parseInt(id)] = true;
            }
        }
        this.updateTreeData();
    }

    onCollapseAll() {
        this.familyTreeState.expandLevel = 1;
        this.familyTreeState.expandedSubsidiaries = {};
        this.familyTreeState.expandedContacts = {};
        for (const rootId of this.familyTreeState.openRootIds) {
            this.familyTreeState.expandedSubsidiaries[rootId] = true;
            this.familyTreeState.expandedContacts[rootId] = true;
        }
        this.updateTreeData();
    }

    onZoomIn() {
        const levels = [50, 75, 100, 125, 150];
        const idx = levels.indexOf(this.familyTreeState.zoomLevel);
        if (idx < levels.length - 1) {
            this.familyTreeState.zoomLevel = levels[idx + 1];
        }
    }

    onZoomOut() {
        const levels = [50, 75, 100, 125, 150];
        const idx = levels.indexOf(this.familyTreeState.zoomLevel);
        if (idx > 0) {
            this.familyTreeState.zoomLevel = levels[idx - 1];
        }
    }

    onZoomReset() {
        this.familyTreeState.zoomLevel = 100;
    }

    // ===================== MODE FUSION =====================
    
    /**
     * Toggle merge mode
     */
    onToggleMergeMode() {
        this.familyTreeState.mergeMode = !this.familyTreeState.mergeMode;
        if (!this.familyTreeState.mergeMode) {
            // Réinitialiser la sélection
            this.familyTreeState.selectedForMerge = {};
        }
    }
    
    /**
     * Toggle selection of a partner for merge
     */
    onToggleMergeSelection(partnerId) {
        if (this.familyTreeState.selectedForMerge[partnerId]) {
            delete this.familyTreeState.selectedForMerge[partnerId];
        } else {
            this.familyTreeState.selectedForMerge[partnerId] = true;
        }
    }
    
    /**
     * Get count of selected partners for merge
     */
    getMergeSelectionCount() {
        return Object.keys(this.familyTreeState.selectedForMerge).length;
    }
    
    /**
     * Fusionner les contacts sélectionnés via l'assistant natif d'Odoo.
     *
     * La fusion maison qui existait ici ne faisait que rattacher les enfants au
     * contact conservé puis archiver les sources : devis, commandes, factures,
     * messages, pièces jointes et abonnements restaient accrochés aux fiches
     * archivées. L'assistant standard (base.action_partner_merge) reporte tout
     * cela, gère les comptes bancaires, journalise l'opération et refuse les
     * fusions dangereuses — autant de cas qu'il n'y a aucune raison de
     * réimplémenter.
     */
    async onMergePartners() {
        const selectedIds = Object.keys(this.familyTreeState.selectedForMerge).map(id => parseInt(id));

        if (selectedIds.length < 2) {
            this.notification.add("Sélectionnez au moins 2 contacts à fusionner", { type: "warning" });
            return;
        }

        // L'assistant lit active_ids pour se pré-remplir : il arrive avec les
        // contacts cochés dans l'arbre et propose le contact à conserver.
        await this.actionService.doAction('base.action_partner_merge', {
            additionalContext: {
                active_model: 'res.partner',
                active_ids: selectedIds,
                active_id: selectedIds[0],
            },
            onClose: async () => {
                this.familyTreeState.mergeMode = false;
                this.familyTreeState.selectedForMerge = {};
                await this.onRefresh();
            },
        });
    }

    /**
     * Cancel merge mode
     */
    onCancelMerge() {
        this.familyTreeState.mergeMode = false;
        this.familyTreeState.selectedForMerge = {};
    }

    // ===================== FIN MODE FUSION =====================

    async onRefresh() {
        const previousRoots = [...this.familyTreeState.openRootIds];
        const previousPartnerName = this.familyTreeState.selectedPartnerName;
        const previousExpandLevel = this.familyTreeState.expandLevel;
        
        // Conserver les expansions
        const savedExpSubsidiaries = { ...this.familyTreeState.expandedSubsidiaries };
        const savedExpContacts = { ...this.familyTreeState.expandedContacts };
        
        // VIDER le cache pour forcer le rechargement complet
        this.recordsById = {};
        
        // Invalider aussi le cache de recherche
        this.allPartnersCache = null;
        this.allPartnersByIdCache = {};
        
        // Reload data
        const fieldsToFetch = [
            'id', 'name', 'display_name', 'parent_id', 'child_ids',
            'is_company', 'email', 'phone', 'function', 'image_128',
            'street', 'city', 'country_id', 'type', 'commercial_partner_id',
            'partner_role'
        ];
        if (this.hasAffiliateField) fieldsToFetch.push('affiliate_ids');
        
        // Recharger TOUTES les généalogies ouvertes, pas seulement la première :
        // une actualisation ne doit pas faire disparaître les autres panneaux.
        if (!previousRoots.length) return;

        const roots = await this.orm.searchRead(
            'res.partner',
            [['id', 'in', previousRoots]],
            fieldsToFetch,
        );
        if (!roots.length) return;

        const rechargees = [];
        for (const root of roots) {
            this.recordsById[root.id] = root;
            await this.loadChildrenForRoot(root.id, fieldsToFetch);
            rechargees.push(root.id);
        }

        // Conserver l'ordre d'ouverture : searchRead ne le garantit pas.
        this._pfSetRoots(previousRoots.filter(id => rechargees.includes(id)));

        // Restore expansions ET le niveau
        this.familyTreeState.expandedSubsidiaries = savedExpSubsidiaries;
        this.familyTreeState.expandedContacts = savedExpContacts;
        this.familyTreeState.expandLevel = previousExpandLevel;
        this.familyTreeState.selectedPartnerName = previousPartnerName;

        this.updateTreeData();
    }

    hasMultipleRoots() {
        return this.familyTreeState.rootOptions.length > 1;
    }

    getInitials(name) {
        if (!name) return "?";
        const parts = name.split(" ").filter(p => p.length > 0);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        }
        return name.substring(0, 2).toUpperCase();
    }

    getImageUrl(record) {
        if (record.image_128) {
            return `data:image/png;base64,${record.image_128}`;
        }
        return null;
    }

    /**
     * Transformation de l'enveloppe : déplacement ET zoom.
     *
     * Le zoom était appliqué sur chaque conteneur d'arbre. Une mise à l'échelle
     * CSS ne change pas l'encombrement réel de l'élément : avec deux généalogies
     * côte à côte, la seconde restait positionnée d'après la largeur NON zoomée
     * de la première, laissant un vide énorme dès qu'on dézoomait. En portant le
     * zoom sur l'enveloppe commune, tout le plan se met à l'échelle d'un bloc et
     * les positions relatives sont conservées.
     */
    getWrapperStyle() {
        const state = this.familyTreeState;
        const scale = state.zoomLevel / 100;
        return `transform: translate(${state.panX}px, ${state.panY}px) scale(${scale})`;
    }

    /**
     * Dézoomer et recadrer pour que TOUTES les généalogies ouvertes tiennent
     * à l'écran.
     *
     * Sans ça, ouvrir une seconde généalogie ne se voyait pas : elle était
     * placée à droite de la première, hors du champ visible, et on croyait
     * que rien ne s'était passé.
     */
    _pfFitToScreen() {
        const wrapper = this.treeWrapperRef.el;
        const viewport = wrapper?.parentElement;
        if (!wrapper || !viewport) return;

        // scrollWidth / scrollHeight donnent l'encombrement NON zoomé : la mise
        // à l'échelle CSS ne change pas la géométrie de mise en page.
        const contenuL = wrapper.scrollWidth;
        const contenuH = wrapper.scrollHeight;
        const vueL = viewport.clientWidth;
        const vueH = viewport.clientHeight;
        if (!contenuL || !contenuH || !vueL || !vueH) return;

        const niveaux = [150, 125, 100, 75, 50];
        const marge = 40;
        const niveau = niveaux.find(
            (z) => contenuL * (z / 100) <= vueL - marge && contenuH * (z / 100) <= vueH - marge
        ) || 50;

        this.familyTreeState.zoomLevel = niveau;
        const echelle = niveau / 100;
        this.familyTreeState.panX = Math.max(0, (vueL - contenuL * echelle) / 2);
        this.familyTreeState.panY = Math.max(0, (vueH - contenuH * echelle) / 2);

        // Les courbes sont tracées à partir de positions mesurées : il faut les
        // refaire une fois le nouveau zoom appliqué.
        setTimeout(() => this.drawBranches(), 60);
    }

    getContainerClass() {
        let classes = 'o_family_tree_container';
        if (this.familyTreeState.reorganizeMode) {
            classes += ' reorganize-mode';
        }
        return classes;
    }

    /**
     * Toggle reorganize mode
     */
    toggleReorganizeMode() {
        this.familyTreeState.reorganizeMode = !this.familyTreeState.reorganizeMode;
        if (!this.familyTreeState.reorganizeMode) {
            // Reset positions when exiting reorganize mode
            this.nodePositions = {};
            // Remove transform styles, sur toutes les généalogies ouvertes
            const wrapper = this.treeWrapperRef.el;
            if (wrapper) {
                wrapper.querySelectorAll('.o_tree_node').forEach(el => {
                    el.style.transform = '';
                    el.style.zIndex = '';
                });
            }
        }
    }

    /**
     * Start dragging a card (visual reorganization only)
     */
    /**
     * Identifiants d'une fiche et de toute sa descendance.
     *
     * Sert à interdire le dépôt d'une fiche sur elle-même ou sur l'un de ses
     * propres descendants : on créerait un cycle, et Odoo refuserait l'écriture
     * avec un message bien plus obscur que de simplement griser la cible.
     */
    _pfSubtreeIds(rootId) {
        const ids = new Set();
        const file = [rootId];
        while (file.length) {
            const id = file.shift();
            if (ids.has(id)) continue;
            ids.add(id);
            const record = this.recordsById[id];
            if (!record) continue;
            for (const enfants of [record.child_ids, record.affiliate_ids]) {
                (enfants || []).forEach((childId) => {
                    if (!ids.has(childId)) file.push(childId);
                });
            }
        }
        return ids;
    }

    onDragStart(ev, node) {
        if (!this.familyTreeState.reorganizeMode) return;
        
        ev.preventDefault();
        ev.stopPropagation();
        
        const nodeEl = ev.target.closest('.o_tree_node');
        if (!nodeEl) return;
        
        const record = this.recordsById[node.id];
        this.dragState = {
            isDragging: true,
            nodeId: node.id,
            nodeEl: nodeEl,
            startX: ev.clientX,
            startY: ev.clientY,
            // Le dépôt remplace le positionnement libre : la fiche repart
            // toujours de sa place, elle ne la conserve jamais.
            offsetX: 0,
            offsetY: 0,
            interdits: this._pfSubtreeIds(node.id),
            parentActuel: record?.parent_id ? record.parent_id[0] : null,
            cibleId: null,
            cibleValide: false,
        };
        
        nodeEl.classList.add('dragging');
        nodeEl.style.zIndex = '1000';
        // Sans ça, elementFromPoint ne verrait que la fiche déplacée.
        nodeEl.style.pointerEvents = 'none';
    }

    /**
     * Mettre en évidence la fiche survolée pendant un glisser.
     */
    _pfUpdateDropTarget(ev) {
        const drag = this.dragState;
        const sousCurseur = document.elementFromPoint(ev.clientX, ev.clientY);
        const carte = sousCurseur && sousCurseur.closest
            ? sousCurseur.closest('.o_partner_card')
            : null;
        const noeud = carte ? carte.closest('.o_tree_node[data-id]') : null;
        const cibleId = noeud ? parseInt(noeud.dataset.id, 10) : null;

        if (cibleId === drag.cibleId) return;

        const wrapper = this.treeWrapperRef.el;
        if (wrapper) {
            wrapper.querySelectorAll('.o_drop_target_valid, .o_drop_target_invalid')
                .forEach((el) => el.classList.remove('o_drop_target_valid', 'o_drop_target_invalid'));
        }

        drag.cibleId = cibleId;
        drag.cibleValide = !!cibleId
            && !drag.interdits.has(cibleId)
            && cibleId !== drag.parentActuel;

        if (carte && cibleId) {
            carte.classList.add(drag.cibleValide ? 'o_drop_target_valid' : 'o_drop_target_invalid');
        }
    }

    /**
     * Rattacher la fiche glissée à la fiche sur laquelle elle a été déposée.
     */
    _pfAskReattach(nodeId, cibleId) {
        const deplacee = this.recordsById[nodeId];
        const cible = this.recordsById[cibleId];
        if (!deplacee || !cible) return;

        const nomDeplacee = deplacee.display_name || deplacee.name;
        const nomCible = cible.display_name || cible.name;

        this.dialogService.add(ConfirmationDialog, {
            title: "Rattacher ce contact",
            body: `Rattacher « ${nomDeplacee} » à « ${nomCible} » ?`,
            confirmLabel: "Rattacher",
            cancelLabel: "Annuler",
            confirm: async () => {
                try {
                    await this.orm.write('res.partner', [nodeId], { parent_id: cibleId });
                    await this.onRefresh();
                    this.notification.add(
                        `« ${nomDeplacee} » est maintenant rattaché à « ${nomCible} ».`,
                        { type: "success" }
                    );
                } catch (error) {
                    this.notification.add(
                        `Rattachement impossible : ${error.message || error}`,
                        { type: "danger" }
                    );
                }
            },
            cancel: () => {},
        });
    }

    /**
     * Mouse move handler for dragging and panning
     */
    _onMouseMove(ev) {
        // Handle node dragging
        if (this.dragState.isDragging) {
            const dx = ev.clientX - this.dragState.startX;
            const dy = ev.clientY - this.dragState.startY;
            
            // La fiche suit le curseur le temps du glisser, uniquement pour
            // montrer ce qu'on déplace : la position n'est jamais conservée.
            if (this.dragState.nodeEl) {
                this.dragState.nodeEl.style.transform = `translate(${dx}px, ${dy}px)`;
            }
            this._pfUpdateDropTarget(ev);
            return;
        }
        
        // Handle view panning
        if (this.panState.isPanning) {
            const dx = ev.clientX - this.panState.startX;
            const dy = ev.clientY - this.panState.startY;
            
            this.familyTreeState.panX = this.panState.startPanX + dx;
            this.familyTreeState.panY = this.panState.startPanY + dy;
            
            // Redraw branches during pan
            this.drawBranches();
        }
    }

    /**
     * Mouse up handler - stop dragging
     */
    _onMouseUp(ev) {
        // Stop node dragging
        if (this.dragState.isDragging) {
            const { nodeId, nodeEl, cibleId, cibleValide } = this.dragState;

            // La fiche revient toujours à sa place : seule l'arborescence
            // réelle décide de sa position, jamais le geste.
            if (nodeEl) {
                nodeEl.classList.remove('dragging');
                nodeEl.style.zIndex = '';
                nodeEl.style.pointerEvents = '';
                nodeEl.style.transform = '';
            }
            const wrapper = this.treeWrapperRef.el;
            if (wrapper) {
                wrapper.querySelectorAll('.o_drop_target_valid, .o_drop_target_invalid')
                    .forEach((el) => el.classList.remove('o_drop_target_valid', 'o_drop_target_invalid'));
            }

            this.dragState = {
                isDragging: false,
                nodeId: null,
                nodeEl: null,
                startX: 0,
                startY: 0,
                offsetX: 0,
                offsetY: 0,
            };

            if (cibleValide && cibleId) {
                this._pfAskReattach(nodeId, cibleId);
            }

            // Redraw branches
            setTimeout(() => this.drawBranches(), 10);
            return;
        }
        
        // Stop panning
        if (this.panState.isPanning) {
            this.panState.isPanning = false;
            document.body.style.cursor = '';
        }
    }
    
    /**
     * Start panning the view
     */
    onPanStart(ev) {
        // Don't pan if clicking on a card or button
        if (ev.target.closest('.o_partner_card, .o_add_child_btn, .o_add_menu, button, .o_expand_toggle, .o_drag_handle, .o_change_parent_btn')) {
            return;
        }
        
        ev.preventDefault();
        this.panState.isPanning = true;
        this.panState.startX = ev.clientX;
        this.panState.startY = ev.clientY;
        this.panState.startPanX = this.familyTreeState.panX;
        this.panState.startPanY = this.familyTreeState.panY;
        document.body.style.cursor = 'grabbing';
    }
    
    /**
     * Zoom with mouse wheel
     */
    onWheel(ev) {
        if (ev.ctrlKey || ev.metaKey) {
            ev.preventDefault();
            
            const delta = -Math.sign(ev.deltaY);
            const levels = [50, 75, 100, 125, 150];
            const currentIdx = levels.indexOf(this.familyTreeState.zoomLevel);
            
            if (delta > 0 && currentIdx < levels.length - 1) {
                // Zoom in
                this.familyTreeState.zoomLevel = levels[currentIdx + 1];
            } else if (delta < 0 && currentIdx > 0) {
                // Zoom out
                this.familyTreeState.zoomLevel = levels[currentIdx - 1];
            }
            
            setTimeout(() => this.drawBranches(), 50);
        }
    }
    
    /**
     * Select a card
     */
    getCardClass(node) {
        let classes = "o_partner_card";
        if (node.record.is_company) {
            classes += " is_company";
        } else {
            classes += " is_contact";
            const type = node.record.type || 'contact';
            classes += ` type-${type}`;
        }
        if (node.isHighlighted) {
            classes += " highlighted";
        }
        if (this.familyTreeState.selectedNodeId === node.id) {
            classes += " selected";
        }
        return classes;
    }
    
    /**
     * Handle search input - Continuous search with collapsible tree dropdown
     */
    async onSearchInput(ev) {
        const query = ev.target.value;
        this.familyTreeState.searchQuery = query;
        
        // Recherche à chaque frappe (si au moins 2 caractères)
        if (query.length < 2) {
            this.familyTreeState.searchResults = [];
            return;
        }
        
        // Debounce search
        clearTimeout(this._searchTimeout);
        this._searchTimeout = setTimeout(async () => {
            await this.performSearch(query);
        }, 150); // Réponse plus rapide car filtre côté client
    }
    
    /**
     * Load all partners for fast client-side search (like in the parent change wizard)
     */
    async loadAllPartnersForSearch() {
        if (this.allPartnersCache) return; // Déjà chargé
        
        try {
            const allPartners = await this.orm.searchRead(
                'res.partner',
                [],
                ['id', 'display_name', 'name', 'is_company', 'type', 'parent_id', 'email', 'phone', 'city', 'partner_role'],
                { order: 'is_company desc, name asc', limit: 5000 }
            );
            
            this.allPartnersCache = allPartners;
            
            // Build index by ID
            this.allPartnersByIdCache = {};
            allPartners.forEach(p => this.allPartnersByIdCache[p.id] = p);
        } catch (error) {
            console.error("Error loading partners for search:", error);
            this.allPartnersCache = [];
        }
    }
    
    /**
     * Get full path of a partner (for display)
     */
    _getPartnerPath(partner) {
        if (!partner) return '';
        const path = [partner.display_name || partner.name];
        let current = partner;
        while (current.parent_id && this.allPartnersByIdCache[current.parent_id[0]]) {
            current = this.allPartnersByIdCache[current.parent_id[0]];
            path.unshift(current.display_name || current.name);
        }
        return path.join(' → ');
    }
    
    /**
     * Perform search - Fast client-side filtering (like parent wizard)
     */
    async performSearch(query) {
        try {
            // Charger tous les partenaires si pas encore fait
            await this.loadAllPartnersForSearch();
            
            if (!this.allPartnersCache || this.allPartnersCache.length === 0) {
                this.familyTreeState.searchResults = [];
                return;
            }
            
            const lowerQuery = query.toLowerCase().trim();
            
            // Filtrer côté client
            const filtered = this.allPartnersCache.filter(p => {
                const searchText = [
                    p.display_name || '',
                    p.name || '',
                    p.email || '',
                    p.phone || '',
                    p.city || '',
                    this._getPartnerPath(p)
                ].join(' ').toLowerCase();
                
                return searchText.includes(lowerQuery);
            });
            
            // Limiter à 50 résultats et enrichir avec le chemin
            this.familyTreeState.searchResults = filtered.slice(0, 50).map(p => ({
                ...p,
                fullPath: this._getPartnerPath(p)
            }));
        } catch (error) {
            console.error("Search error:", error);
            this.familyTreeState.searchResults = [];
        }
    }
    
    /**
     * Handle search focus - preload partners
     */
    async onSearchFocus() {
        await this.loadAllPartnersForSearch();
    }
    
    /**
     * Handle search keydown (Enter to select first result)
     */
    onSearchKeydown(ev) {
        if (ev.key === 'Enter' && this.familyTreeState.searchResults.length > 0) {
            this.onSelectSearchResult(this.familyTreeState.searchResults[0]);
        }
        if (ev.key === 'Escape') {
            this.onClearSearch();
        }
    }
    
    /**
     * Clear search
     */
    onClearSearch() {
        this.familyTreeState.searchQuery = '';
        this.familyTreeState.searchResults = [];
    }
    
    /**
     * Clear search completely (including selected partner) and return to welcome screen
     */
    onClearSearchFull() {
        this.familyTreeState.searchQuery = '';
        this.familyTreeState.searchResults = [];
        this.familyTreeState.selectedPartnerName = '';
        this._pfSetRoots([]);
        this.familyTreeState.treeData = null;
        this.familyTreeState.treeDataList = [];
        this.highlightPartnerId = null;
        this.highlightedIds.clear();
    }
    
    /**
     * Handle search input focus - clear selected partner display
     */
    onSearchFocus() {
        // Keep the selected partner but clear the display for new search
    }
    
    /**
     * Handle click on search result item
     */
    async onClickSearchResult(ev) {
        const resultId = parseInt(ev.currentTarget.dataset.resultId, 10);
        const result = this.familyTreeState.searchResults.find(r => r.id === resultId);
        if (result) {
            await this.onSelectSearchResult(result);
        }
    }

    /**
     * Ouvrir une généalogie **à côté** de celles déjà affichées, au lieu de les
     * remplacer : c'est ce qui permet de réaffilier d'un groupe à l'autre sans
     * ouvrir deux écrans.
     */
    async onAddSearchResult(ev) {
        const resultId = parseInt(ev.currentTarget.dataset.resultId, 10);
        const result = this.familyTreeState.searchResults.find(r => r.id === resultId);
        if (result) {
            await this.onSelectSearchResult(result, true);
        }
    }

    /**
     * Fermer une généalogie. La dernière encore ouverte ne peut pas être fermée :
     * on retomberait sur un écran vide sans moyen évident de revenir.
     */
    onCloseRoot(ev) {
        const rootId = parseInt(ev.currentTarget.dataset.rootId, 10);
        const state = this.familyTreeState;
        if (state.openRootIds.length <= 1) return;
        this._pfSetRoots(state.openRootIds.filter(id => id !== rootId));
        this.updateTreeData();
        this.recalculateExpandLevel();
        setTimeout(() => this._pfFitToScreen(), 150);
    }
    
    /**
     * Select a search result and navigate to it
     */
    async onSelectSearchResult(result, append = false) {
        // Save the selected partner name and keep it in search query for editing
        this.familyTreeState.selectedPartnerName = result.display_name;
        this.familyTreeState.searchQuery = result.display_name; // Garder le nom pour pouvoir le modifier
        this.familyTreeState.searchResults = [];
        
        // Find the root company for this partner
        let rootId = result.id;
        let current = result;
        
        // If the result has a parent, find the ultimate root
        if (result.parent_id) {
            // Load parent chain to find root
            let parentId = result.parent_id[0];
            while (parentId) {
                const parents = await this.orm.searchRead(
                    "res.partner",
                    [['id', '=', parentId]],
                    ['id', 'parent_id', 'is_company']
                );
                if (parents.length > 0) {
                    rootId = parents[0].id;
                    if (parents[0].parent_id) {
                        parentId = parents[0].parent_id[0];
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
        }
        
        // Fields to fetch
        const fieldsToFetch = [
            'id', 'name', 'display_name', 'parent_id', 'child_ids',
            'is_company', 'email', 'phone', 'function', 'image_128',
            'street', 'city', 'country_id', 'type', 'commercial_partner_id',
            'partner_role'
        ];
        if (this.hasAffiliateField) fieldsToFetch.push('affiliate_ids');
        
        // TOUJOURS recharger la racine et ses enfants pour avoir les données à jour.
        // En mode ajout en revanche, le cache doit survivre : les généalogies déjà
        // ouvertes y puisent leurs enregistrements, et le vider ferait disparaître
        // leurs panneaux — on ne rechargerait que la branche ajoutée.
        if (!append) {
            this.recordsById = {};
        }
        
        // Charger la racine avec toutes ses données
        const rootRecords = await this.orm.searchRead(
            "res.partner",
            [['id', '=', rootId]],
            fieldsToFetch,
            { limit: 1 }
        );
        
        if (rootRecords.length > 0) {
            this.recordsById[rootId] = rootRecords[0];
        }
        
        // Set the new root — en mode ajout, les généalogies déjà ouvertes restent.
        this._pfSetRoots([rootId], append);
        
        // Reset expansions. En mode ajout on conserve celles des autres
        // généalogies : les replier parce qu'on en ouvre une nouvelle serait
        // exactement ce qu'on cherche à éviter.
        if (!append) {
            this.familyTreeState.expandedSubsidiaries = {};
            this.familyTreeState.expandedContacts = {};
        }
        this.familyTreeState.expandedSubsidiaries[rootId] = true;
        this.familyTreeState.expandedContacts[rootId] = true;
        
        // Charger TOUS les enfants récursivement
        await this.loadChildrenForRoot(rootId, fieldsToFetch);
        
        // Expand path to the selected partner
        this.expandPathToPartner(result.id);
        
        // Highlight the selected partner
        this.highlightPartnerId = result.id;
        this.calculateHighlightedLineage();
        this.updateTreeData();
        this.recalculateExpandLevel();
        
        // Après un ajout, on recadre sur l'ensemble : montrer uniquement la
        // nouvelle généalogie donnerait l'impression que l'autre a disparu.
        setTimeout(() => {
            if (append) {
                this._pfFitToScreen();
            } else {
                this.scrollToPartner(result.id);
            }
        }, 200);
    }
    
    /**
     * Expand all nodes in the path to a partner
     */
    expandPathToPartner(partnerId) {
        const record = this.recordsById[partnerId];
        if (!record) return;
        
        // Expand the partner itself
        this.familyTreeState.expandedSubsidiaries[partnerId] = true;
        this.familyTreeState.expandedContacts[partnerId] = true;
        
        // Expand all ancestors
        let current = record;
        while (current?.parent_id) {
            const parentId = current.parent_id[0];
            this.familyTreeState.expandedSubsidiaries[parentId] = true;
            this.familyTreeState.expandedContacts[parentId] = true;
            current = this.recordsById[parentId];
        }
    }
    
    /**
     * Scroll to center on a specific partner
     */
    scrollToPartner(partnerId) {
        // La fiche peut se trouver dans n'importe laquelle des généalogies
        // ouvertes : on cherche dans l'enveloppe commune, et on se repère sur le
        // conteneur du panneau qui la contient.
        const wrapper = this.treeWrapperRef.el;
        const card = wrapper?.querySelector(`[data-id="${partnerId}"] .o_partner_card`);
        const container = card?.closest('.o_family_tree_container');
        if (card && container) {
            const rect = card.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            
            // Calculate offset to center the card
            const offsetX = rect.left - containerRect.left - (window.innerWidth / 2) + (rect.width / 2);
            const offsetY = rect.top - containerRect.top - (window.innerHeight / 2) + (rect.height / 2);
            
            this.familyTreeState.panX = -offsetX;
            this.familyTreeState.panY = -offsetY;
            
            // Add visual feedback
            card.classList.add('search-highlight');
            setTimeout(() => {
                card.classList.remove('search-highlight');
            }, 2000);
        }
    }
}
