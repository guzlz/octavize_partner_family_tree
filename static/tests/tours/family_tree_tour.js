/** @odoo-module **/

import { registry } from "@web/core/registry";

/**
 * Plusieurs généalogies ouvertes en même temps dans la vue Arbre.
 *
 * Le scénario reproduit exactement le besoin : afficher deux groupes côte à côte
 * pour pouvoir réaffilier de l'un vers l'autre sans ouvrir deux écrans.
 */
registry.category("web_tour.tours").add("family_tree_multi", {
    steps: () => [
        {
            content: "Chercher le premier groupe",
            trigger: ".o_search_input",
            run: "edit ZZ Groupe Alpha",
        },
        {
            content: "Ouvrir la première généalogie",
            trigger: ".o_search_results .o_search_result_item:contains(ZZ Groupe Alpha)",
            run: "click",
        },
        {
            content: "La première généalogie est affichée",
            trigger: ".o_family_tree_pane .o_partner_card:contains(ZZ Groupe Alpha)",
        },
        {
            content: "Chercher le second groupe",
            trigger: ".o_search_input",
            run: "edit ZZ Groupe Beta",
        },
        {
            content: "Ouvrir la seconde généalogie À CÔTÉ de la première",
            trigger: ".o_search_results .o_search_result_item:contains(ZZ Groupe Beta) .o_result_add",
            run: "click",
        },
        {
            content: "Les deux groupes sont visibles simultanément",
            trigger: ".o_family_tree_wrapper:has(.o_partner_card:contains(ZZ Groupe Alpha)):has(.o_partner_card:contains(ZZ Groupe Beta))",
        },
        {
            content: "Chaque généalogie a son panneau et son en-tête",
            trigger: ".o_family_tree_pane:nth-of-type(2) .o_family_tree_pane_header",
        },
        {
            content: "Fermer la seconde généalogie",
            trigger: ".o_family_tree_pane:nth-of-type(2) .o_pane_close",
            run: "click",
        },
        {
            content: "Il ne reste que la première",
            trigger: ".o_family_tree_wrapper:not(:has(.o_partner_card:contains(ZZ Groupe Beta)))",
        },
        {
            content: "La première est toujours là",
            trigger: ".o_family_tree_pane .o_partner_card:contains(ZZ Groupe Alpha)",
        },
    ],
});
