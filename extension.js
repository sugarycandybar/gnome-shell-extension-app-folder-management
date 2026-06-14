import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

const FolderIcon = AppDisplay.FolderIcon;
const AppIcon = AppDisplay.AppIcon;

const CASCADE_INTERVAL = 80;
const CASCADE_DURATION = 350;
const FOLDER_FADE_DURATION = 200;

class FolderPopupMenu extends PopupMenu.PopupMenu {
    constructor(sourceActor) {
        let side = St.Side.LEFT;
        if (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL)
            side = St.Side.RIGHT;

        super(sourceActor, 0.5, side);
        this.actor.add_style_class_name('app-menu');

        this.addAction(_('Ungroup Folder'), () => {
            this._ungroup();
        });
    }

    _ungroup() {
        const icon = this.sourceActor;
        const folderView = icon.view;
        const folderSettings = folderView._folder;
        const folderId = folderView._id;
        const parentView = icon._parentView;
        const appIds = icon.getAppIds();

        this.close();

        const onAnimDone = () => {
            let folderPage = 0;
            const folderPos = parentView._pageManager.getAppPosition(folderId);
            if (folderPos[0] >= 0)
                folderPage = folderPos[0];

            let viewLoadedId = 0;
            viewLoadedId = parentView.connect('view-loaded', () => {
                parentView.disconnect(viewLoadedId);

                const existingCount = parentView._grid.getItemsAtPage(folderPage)
                    .filter(c => c.visible).length;

                appIds.forEach((appId, i) => {
                    const appIcon = parentView._items.get(appId);
                    if (!appIcon)
                        return;

                    parentView._moveItem(appIcon, folderPage, existingCount + i);
                });

                parentView._savePages();

                appIds.forEach((appId, i) => {
                    const appIcon = parentView._items.get(appId);
                    if (!appIcon)
                        return;

                    appIcon.scale_x = 0;
                    appIcon.scale_y = 0;

                    appIcon.ease({
                        scale_x: 1,
                        scale_y: 1,
                        delay: i * CASCADE_INTERVAL,
                        duration: CASCADE_DURATION,
                        mode: Clutter.AnimationMode.EASE_OUT_QUINT,
                    });
                });
            });
        };

        if (icon.visible) {
            icon.ease({
                scale_x: 0,
                scale_y: 0,
                opacity: 0,
                duration: FOLDER_FADE_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUINT,
                onComplete: () => {
                    folderSettings.reset('apps');
                    folderSettings.reset('categories');
                    folderSettings.reset('excluded-apps');
                    folderSettings.reset('name');
                    folderSettings.reset('translate');

                    const settings = new Gio.Settings({
                        schema_id: 'org.gnome.desktop.app-folders',
                    });
                    const folders = settings.get_strv('folder-children');
                    const idx = folders.indexOf(folderId);
                    if (idx >= 0) {
                        folders.splice(idx, 1);
                        settings.set_strv('folder-children', folders);
                    }

                    onAnimDone();
                },
            });
        } else {
            const keys = folderSettings.settings_schema.list_keys();
            for (const key of keys)
                folderSettings.reset(key);

            const settings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.app-folders',
            });
            const folders = settings.get_strv('folder-children');
            const idx = folders.indexOf(folderId);
            if (idx >= 0) {
                folders.splice(idx, 1);
                settings.set_strv('folder-children', folders);
            }

            onAnimDone();
        }
    }
}

export default class UngroupFolderExtension extends Extension {
    enable() {
        log('fm: enable');

        this._origInit = FolderIcon.prototype._init;
        this._selectMode = false;
        this._appDisplay = null;
        this._selectedApps = new Set();
        this._checkOverlays = new Map();
        this._emptySpaceAnchor = null;

        const self = this;
        FolderIcon.prototype._init = function (id, path, parentView) {
            self._origInit.call(this, id, path, parentView);

            this.connect('popup-menu', () => {
                this.popupMenu();
                if (this._menu)
                    this._menu.actor.navigate_focus(
                        null, St.DirectionType.TAB_FORWARD, false);
            });
        };

        FolderIcon.prototype.popupMenu = function () {
            if (!this._menu) {
                this._menu = new FolderPopupMenu(this);
                this._menu.connect('open-state-changed', (menu, open) => {
                    if (!open)
                        this._onFolderMenuPoppedDown();
                });
                Main.overview.connectObject('hiding',
                    () => this._menu.close(), this);
                Main.uiGroup.add_child(this._menu.actor);
                this._menuManager = new PopupMenu.PopupMenuManager(this);
                this._menuManager.addMenu(this._menu);
            }

            this._menu.open(BoxPointer.PopupAnimation.FULL);
        };

        FolderIcon.prototype._onFolderMenuPoppedDown = function () {
        };

        this._selectBar = new St.BoxLayout({
            style: 'background-color: rgba(0, 0, 0, 0.7); border-radius: 12px; ' +
                'padding: 8px 16px; spacing: 12px;',
            visible: false,
            reactive: true,
        });

        this._selectCountLabel = new St.Label({
            text: '',
            style: 'color: white; font-weight: bold;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._groupButton = new St.Button({
            label: _('New folder'),
            style_class: 'button',
            track_hover: true,
            reactive: false,
        });
        this._groupButton.connect('clicked', () => {
            log('fm: group button clicked');
            this._groupSelected();
        });

        this._cancelButton = new St.Button({
            label: _('Cancel'),
            style_class: 'button',
            track_hover: true,
        });
        this._cancelButton.connect('clicked', () => this._exitSelectMode());

        this._selectBar.add_child(this._selectCountLabel);
        this._selectBar.add_child(new St.Widget({x_expand: true}));
        this._selectBar.add_child(this._groupButton);
        this._selectBar.add_child(this._cancelButton);
        Main.uiGroup.add_child(this._selectBar);

        const dash = Main.overview?.controls?.dash;
        if (dash) {
            this._dashAllocId = dash.connect('notify::allocation', () => {
                this._positionSelectBar();
            });
        }

        this._overviewHideId = Main.overview.connect('hiding', () => {
            if (this._selectMode)
                this._exitSelectMode();
        });

        this._capturedId = global.stage.connect('captured-event', (actor, event) => {
            if (!this._selectMode)
                return Clutter.EVENT_PROPAGATE;
            if (event.type() !== Clutter.EventType.BUTTON_PRESS)
                return Clutter.EVENT_PROPAGATE;
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;

            let target = global.stage.get_event_actor(event);
            if (!target)
                return Clutter.EVENT_PROPAGATE;

            for (let icon = target; icon; icon = icon.get_parent()) {
                if (icon instanceof FolderIcon) {
                    return Clutter.EVENT_STOP;
                }
                if (icon instanceof AppIcon) {
                    this._toggleApp(icon);
                    return Clutter.EVENT_STOP;
                }
            }

            return Clutter.EVENT_PROPAGATE;
        });

        this._stageHandlerId = global.stage.connect('button-press-event',
            (actor, event) => {
                if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                    return Clutter.EVENT_PROPAGATE;

                let target = global.stage.get_event_actor(event);
                if (!target)
                    return Clutter.EVENT_PROPAGATE;

                log(`fm: right-click target=${target}`);

                let folderIcon = null;
                let hasAppIcon = false;
                let hasAppDisplay = false;

                for (let el = target; el; el = el.get_parent()) {
                    if (el instanceof FolderIcon)
                        folderIcon = el;
                    if (el instanceof AppIcon)
                        hasAppIcon = true;
                    if (el instanceof AppDisplay.AppDisplay)
                        hasAppDisplay = true;
                }

                if (folderIcon && !this._selectMode) {
                    folderIcon.popupMenu();
                    return Clutter.EVENT_STOP;
                }

                if (hasAppDisplay && !hasAppIcon && !folderIcon) {
                    if (!this._selectMode) {
                        this._showEmptySpaceMenu(event);
                        return Clutter.EVENT_STOP;
                    }
                }

                return Clutter.EVENT_PROPAGATE;
            });
    }

    _getAppDisplay() {
        if (this._appDisplay)
            return this._appDisplay;
        return null;
    }

    _findAppDisplayFromIcon(appIcon) {
        let p = appIcon.get_parent();
        while (p) {
            if (p instanceof AppDisplay.AppDisplay) {
                this._appDisplay = p;
                return true;
            }
            p = p.get_parent();
        }
        return false;
    }

    _positionSelectBar() {
        const barWidth = 500;
        const stageWidth = global.stage.get_width();
        const stageHeight = global.stage.get_height();
        this._selectBar.set_size(barWidth, -1);
        const [, nath] = this._selectBar.get_preferred_height(barWidth);
        this._selectBar.set_size(barWidth, nath);
        this._selectBar.set_position(
            Math.round((stageWidth - barWidth) / 2),
            stageHeight - 150 - nath);
    }

    _enterSelectMode() {
        this._selectMode = true;
        this._selectedApps.clear();
        this._groupButton.reactive = false;
        this._selectCountLabel.text = ngettext('Selected %d app', 'Selected %d apps', 0).format(0);
        this._positionSelectBar();
        this._selectBar.set_opacity(0);
        this._selectBar.set_translation(0, 12, 0);
        this._selectBar.show();
        this._selectBar.ease({
            opacity: 255,
            translation_y: 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _exitSelectMode() {
        this._selectMode = false;
        this._selectedApps.clear();

        this._selectBar.ease({
            opacity: 0,
            translation_y: 12,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._selectBar.hide();
            },
        });

        for (const appId of this._checkOverlays.keys())
            this._removeCheckOverlay(appId);
    }

    _toggleApp(appIcon) {
        const appId = appIcon.id;
        if (!appId)
            return;

        log(`fm: _toggleApp ${appId}, was selected=${this._selectedApps.has(appId)}`);

        if (!this._appDisplay)
            this._findAppDisplayFromIcon(appIcon);

        if (this._selectedApps.has(appId)) {
            this._selectedApps.delete(appId);
            this._removeCheckOverlay(appId);
            appIcon.setForcedHighlight(false);
        } else {
            this._selectedApps.add(appId);
            appIcon.setForcedHighlight(true);
            this._addCheckOverlay(appIcon, appId);
        }

        log(`fm: selected size=${this._selectedApps.size}, button reactive=${this._selectedApps.size >= 1}`);
        this._groupButton.reactive = this._selectedApps.size >= 1;
        this._selectCountLabel.text = ngettext('Selected %d app', 'Selected %d apps', this._selectedApps.size).format(this._selectedApps.size);
    }

    _addCheckOverlay(appIcon, appId) {
        if (this._checkOverlays.has(appId))
            return;

        const overlay = new St.Bin({
            reactive: false,
            style: 'background-color: -st-accent-color; ' +
                'border-radius: 999px; ' +
                'box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        overlay.set_size(26, 26);

        const icon = new St.Icon({
            icon_name: 'object-select-symbolic',
            style: 'color: -st-accent-fg-color;',
            icon_size: 16,
        });
        overlay.child = icon;

        appIcon.add_child(overlay);

        overlay.set_opacity(0);
        overlay.ease({
            opacity: 255,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._checkOverlays.set(appId, {overlay, appIcon});
    }

    _removeCheckOverlay(appId) {
        const data = this._checkOverlays.get(appId);
        if (!data)
            return;

        data.appIcon.setForcedHighlight(false);
        data.overlay.destroy();
        this._checkOverlays.delete(appId);
    }

    _groupSelected() {
        log(`fm: _groupSelected, selected size=${this._selectedApps.size}`);

        if (this._selectedApps.size < 1) {
            log('fm: not enough selected');
            return;
        }

        const appDisplay = this._getAppDisplay();
        log(`fm: appDisplay=${!!appDisplay}`);

        if (!appDisplay) {
            log('fm: no appDisplay');
            return;
        }

        const appIds = [...this._selectedApps];
        log(`fm: appIds=${JSON.stringify(appIds)}`);

        const appIcons = [];
        for (const appId of appIds) {
            const data = this._checkOverlays.get(appId);
            if (data)
                appIcons.push(data.appIcon);
        }

        for (const appId of appIds)
            this._removeCheckOverlay(appId);

        const onAnimDone = () => {
            for (const icon of appIcons) {
                icon.set_scale(1, 1);
                icon.opacity = 255;
            }

            this._exitSelectMode();

            try {
                appDisplay.createFolder(appIds);
            } catch (e) {
                log(`fm: createFolder error: ${e}`);
                log(e.stack);
            }
        };

        if (appIcons.length > 0) {
            let completed = 0;
            appIcons.forEach((icon, i) => {
                icon.ease({
                    scale_x: 0,
                    scale_y: 0,
                    opacity: 0,
                    delay: i * 50,
                    duration: 300,
                    mode: Clutter.AnimationMode.EASE_OUT_QUINT,
                    onComplete: () => {
                        completed++;
                        if (completed === appIcons.length)
                            onAnimDone();
                    },
                });
            });
        } else {
            onAnimDone();
        }
    }

    _showEmptySpaceMenu(event) {
        if (this._emptySpaceAnchor) {
            this._emptySpaceAnchor.destroy();
            this._emptySpaceAnchor = null;
        }

        const [stageX, stageY] = event.get_coords();

        const anchor = new St.Widget({
            reactive: false,
            width: 1,
            height: 1,
        });
        anchor.set_position(stageX, stageY);
        Main.uiGroup.add_child(anchor);
        this._emptySpaceAnchor = anchor;

        const menu = new PopupMenu.PopupMenu(anchor, 0.5, St.Side.TOP);
        menu.actor.add_style_class_name('app-menu');

        menu.addAction(_('Select Apps'), () => {
            this._enterSelectMode();
        });

        menu.connect('open-state-changed', (m, open) => {
            if (!open) {
                anchor.destroy();
                m.actor.destroy();
                if (this._emptySpaceAnchor === anchor)
                    this._emptySpaceAnchor = null;
            }
        });

        Main.uiGroup.add_child(menu.actor);
        const menuManager = new PopupMenu.PopupMenuManager(anchor);
        menuManager.addMenu(menu);

        menu.open(BoxPointer.PopupAnimation.FULL);
    }

    disable() {
        FolderIcon.prototype._init = this._origInit;
        FolderIcon.prototype.popupMenu = function () {};
        FolderIcon.prototype._onFolderMenuPoppedDown = function () {};

        if (this._stageHandlerId) {
            global.stage.disconnect(this._stageHandlerId);
            this._stageHandlerId = 0;
        }
        if (this._capturedId) {
            global.stage.disconnect(this._capturedId);
            this._capturedId = 0;
        }
        if (this._overviewHideId) {
            Main.overview.disconnect(this._overviewHideId);
            this._overviewHideId = 0;
        }

        this._exitSelectMode();
        for (const appId of this._checkOverlays.keys())
            this._removeCheckOverlay(appId);

        if (this._selectBar) {
            this._selectBar.destroy();
            this._selectBar = null;
        }

        if (this._dashAllocId && Main.overview?.controls?.dash) {
            Main.overview.controls.dash.disconnect(this._dashAllocId);
            this._dashAllocId = 0;
        }

        if (this._emptySpaceAnchor) {
            this._emptySpaceAnchor.destroy();
            this._emptySpaceAnchor = null;
        }
    }
}
