/** @odoo-module **/

import { registry } from "@web/core/registry";
import { kanbanView } from "@web/views/kanban/kanban_view";
import { FamilyTreeController } from "./family_tree_controller";
import { FamilyTreeRenderer } from "./family_tree_renderer";

/**
 * Partner Family Tree View
 * Extends kanban view with custom controller and renderer for family tree display
 */
export const partnerFamilyTreeView = {
    ...kanbanView,
    Controller: FamilyTreeController,
    Renderer: FamilyTreeRenderer,
    buttonTemplate: "octavize_family_tree.KanbanView.Buttons",
};

// Register the view with js_class name
registry.category("views").add("octavize_family_tree", partnerFamilyTreeView);

