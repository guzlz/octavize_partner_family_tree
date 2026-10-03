# -*- coding: utf-8 -*-
{
    'name': 'Octavize Partner Family Tree',
    'version': '19.0.2.0.0',
    'summary': 'Visualize contacts hierarchy as a family tree / org chart',
    'description': """
        This module adds a new view type to visualize res.partner records
        in a hierarchical tree structure (family tree / org chart style).
        It is done for sales to unlock a new way to modify their contacts
        and avoid errors creating duplicates.

        Features:
        - Visual tree representation of partner hierarchy
        - Mindmap-style curved branches
        - Shows parent/child relationships between companies and contacts
        - Interactive navigation through the tree, several genealogies open side by side
        - Click on nodes to view partner details
        - Expandable/collapsible branches
        - Simple wizard to change parent relationships
        - Open tree from any contact with lineage highlighting
        - Create quotations directly from partner cards (requires Sale module)
        - Role badges (parent company / subsidiary / standalone company / reference
          contact / invoice, delivery, private and other addresses / individual /
          sole trader), consistent across the tree, the form, the lists and the kanbans
        - Dedicated "Subsidiaries" tab on the company form, separate from the
          contacts/addresses tab
        - Configurable naming standard for contact records (company name order,
          "LAST NAME First name" for individuals), with a non-blocking inline hint
          and warnings on the partner form
    """,
    'category': 'Sales/CRM',
    'author': 'Octavize',
    'website': 'https://www.octavize.fr',
    'maintainer': 'Octavize',
    'license': 'LGPL-3',
    'depends': [
        'base',
        'contacts',
        'web',
        'sale',
    ],
    'data': [
        'security/ir.model.access.csv',
        'data/naming_norm_data.xml',
        'wizard/change_parent_wizard_views.xml',
        'views/res_partner_views.xml',
        'views/naming_norm_views.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'octavize_partner_family_tree/static/src/css/family_tree.css',
            'octavize_partner_family_tree/static/src/css/partner_role_badge.css',
            'octavize_partner_family_tree/static/src/js/family_tree_controller.js',
            'octavize_partner_family_tree/static/src/js/family_tree_renderer.js',
            'octavize_partner_family_tree/static/src/js/family_tree_view.js',
            'octavize_partner_family_tree/static/src/xml/family_tree_templates.xml',
        ],
        'web.assets_tests': [
            'octavize_partner_family_tree/static/tests/tours/**/*',
        ],
    },
    'installable': True,
    'application': False,
    'auto_install': False,
}
