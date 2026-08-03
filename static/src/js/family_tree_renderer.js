/** @odoo-module **/

import { KanbanRenderer } from "@web/views/kanban/kanban_renderer";

/**
 * Family Tree Renderer
 * Extends KanbanRenderer with custom template for tree visualization
 */
export class FamilyTreeRenderer extends KanbanRenderer {
    static template = "octavize_family_tree.FamilyTreeRenderer";
}

