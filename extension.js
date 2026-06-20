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
    constructor(sourceActor, extension) {
        let side = St.Side.LEFT;
        if (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL)
            side = St.Side.RIGHT;

        super(sourceActor, 0.5, side);
        this.actor.add_style_class_name('app-menu');
        this._extension = extension;

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

        if (!this._extension._enabled)
            return;

        const completeUngroup = () => {
            if (!this._extension._enabled)
                return;

            let folderPage = 0;
            const folderPos = parentView._pageManager.getAppPosition(folderId);
            if (folderPos[0] >= 0)
                folderPage = folderPos[0];

            this._connectViewLoaded(parentView, folderPage, appIds);
        };

        if (icon.visible) {
            icon.ease({
                scale_x: 0,
                scale_y: 0,
                opacity: 0,
                duration: FOLDER_FADE_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUINT,
                onComplete: () => {
                    if (!this._extension._enabled)
                        return;

                    folderSettings.reset('apps');
                    folderSettings.reset('categories');
                    folderSettings.reset('excluded-apps');
                    folderSettings.reset('name');
                    folderSettings.reset('translate');

                    this._removeFromFolderList(folderId);
                    completeUngroup();
                },
            });
        } else {
            const keys = folderSettings.settings_schema.list_keys();
            for (const key of keys)
                folderSettings.reset(key);

            this._removeFromFolderList(folderId);
            completeUngroup();
        }
    }

    _removeFromFolderList(folderId) {
        const settings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.app-folders',
        });
        const folders = settings.get_strv('folder-children');
        const idx = folders.indexOf(folderId);
        if (idx >= 0) {
            folders.splice(idx, 1);
            settings.set_strv('folder-children', folders);
        }
    }

    _connectViewLoaded(parentView, folderPage, appIds) {
        if (this._extension._viewLoadedConnections.has(parentView)) {
            try {
                parentView.disconnect(
                    this._extension._viewLoadedConnections.get(parentView));
            } catch (e) {}
            this._extension._viewLoadedConnections.delete(parentView);
        }

        const viewLoadedId = parentView.connect('view-loaded', () => {
            try {
                parentView.disconnect(viewLoadedId);
            } catch (e) {}
            this._extension._viewLoadedConnections.delete(parentView);

            if (!this._extension._enabled)
                return;

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

        this._extension._viewLoadedConnections.set(parentView, viewLoadedId);
    }
}

export default class UngroupFolderExtension extends Extension {
    enable() {
        this._saveOriginals();
        this._initState();
        this._patchFolderIcon();
        this._patchPopupMenu();
        this._createSelectBar();
        this._connectSignals();
    }

    _saveOriginals() {
        this._origInit = FolderIcon.prototype._init;
        this._origPopupMenu = FolderIcon.prototype.popupMenu;
        this._origOnPoppedDown = FolderIcon.prototype._onFolderMenuPoppedDown;
    }

    _initState() {
        this._selectMode = false;
        this._appDisplay = null;
        this._selectedApps = new Set();
        this._checkOverlays = new Map();
        this._emptySpaceAnchor = null;
        this._emptySpaceMenu = null;
        this._emptySpaceMenuOpenId = 0;
        this._folderIconSignals = new Map();
        this._viewLoadedConnections = new Map();
        this._groupAnimIcons = null;
        this._enabled = true;
    }

    _patchFolderIcon() {
        const self = this;
        FolderIcon.prototype._init = function (id, path, parentView) {
            self._origInit.call(this, id, path, parentView);

            const handlerId = this.connect('popup-menu', () => {
                this.popupMenu();
                if (this._menu)
                    this._menu.actor.navigate_focus(
                        null, St.DirectionType.TAB_FORWARD, false);
            });
            self._folderIconSignals.set(this, handlerId);
        };
    }

    _patchPopupMenu() {
        const self = this;
        FolderIcon.prototype.popupMenu = function () {
            if (!this._menu) {
                this._menu = new FolderPopupMenu(this, self);
                this._openStateChangedId = this._menu.connect(
                    'open-state-changed', (menu, open) => {
                        if (!open)
                            this._onFolderMenuPoppedDown();
                    });
                Main.uiGroup.add_child(this._menu.actor);
                this._menuManager = new PopupMenu.PopupMenuManager(this);
                this._menuManager.addMenu(this._menu);

                Main.overview.connectObject('hiding',
                    () => this._menu.close(), this._menu);
            }

            this._menu.open(BoxPointer.PopupAnimation.FULL);
        };

        FolderIcon.prototype._onFolderMenuPoppedDown = function () {
        };
    }

    _createSelectBar() {
        this._selectBar = new St.BoxLayout({
            style_class: 'app-folder-management-select-bar',
            visible: false,
            reactive: true,
        });

        this._selectCountLabel = new St.Label({
            text: '',
            style_class: 'app-folder-management-select-count',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._groupButton = new St.Button({
            label: _('New folder'),
            style_class: 'button',
            track_hover: true,
            reactive: false,
        });
        this._groupButtonClickedId = this._groupButton.connect('clicked', () => {
            this._groupSelected();
        });

        this._cancelButton = new St.Button({
            label: _('Cancel'),
            style_class: 'button',
            track_hover: true,
        });
        this._cancelButtonClickedId = this._cancelButton.connect(
            'clicked', () => this._exitSelectMode());

        this._selectBar.add_child(this._selectCountLabel);
        this._selectBar.add_child(new St.Widget({x_expand: true}));
        this._selectBar.add_child(this._groupButton);
        this._selectBar.add_child(this._cancelButton);
        Main.uiGroup.add_child(this._selectBar);
    }

    _connectSignals() {
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
                if (icon instanceof FolderIcon)
                    return Clutter.EVENT_STOP;
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
        this._selectCountLabel.text = ngettext(
            'Selected %d app', 'Selected %d apps', 0).format(0);
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

        if (!this._appDisplay)
            this._findAppDisplayFromIcon(appIcon);

        if (this._selectedApps.has(appId)) {
            this._selectedApps.delete(appId);
            this._removeCheckOverlay(appId);
        } else {
            this._selectedApps.add(appId);
            appIcon.setForcedHighlight(true);
            this._addCheckOverlay(appIcon, appId);
        }

        this._groupButton.reactive = this._selectedApps.size >= 1;
        this._selectCountLabel.text = ngettext(
            'Selected %d app', 'Selected %d apps',
            this._selectedApps.size).format(this._selectedApps.size);
    }

    _addCheckOverlay(appIcon, appId) {
        if (this._checkOverlays.has(appId))
            return;

        const overlay = new St.Bin({
            reactive: false,
            style_class: 'app-folder-management-check-overlay',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        overlay.set_size(26, 26);

        const icon = new St.Icon({
            icon_name: 'object-select-symbolic',
            style_class: 'app-folder-management-check-icon',
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
        if (this._selectedApps.size < 1)
            return;

        const appIds = [...this._selectedApps];

        const appIcons = [];
        for (const appId of appIds) {
            const data = this._checkOverlays.get(appId);
            if (data)
                appIcons.push(data.appIcon);
        }

        for (const appId of appIds)
            this._removeCheckOverlay(appId);

        this._groupAnimIcons = appIcons;

        this._appDisplay = null;
        if (appIcons.length > 0)
            this._findAppDisplayFromIcon(appIcons[0]);
        const appDisplay = this._appDisplay;
        if (!appDisplay)
            return;

        const onAnimDone = () => {
            if (!this._enabled)
                return;

            for (const icon of appIcons) {
                icon.set_scale(1, 1);
                icon.opacity = 255;
            }

            this._groupAnimIcons = null;
            this._exitSelectMode();

            try {
                appDisplay.createFolder(appIds);
            } catch (e) {
                this.log(`createFolder error: ${e}`);
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

    _showEmptySpaceMenu(event) {
        if (this._emptySpaceAnchor) {
            this._emptySpaceAnchor.destroy();
            this._emptySpaceAnchor = null;
        }
        if (this._emptySpaceMenu) {
            this._emptySpaceMenu.actor.destroy();
            this._emptySpaceMenu = null;
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

        this._emptySpaceMenuOpenId = menu.connect('open-state-changed', (m, open) => {
            if (!open) {
                anchor.destroy();
                m.actor.destroy();
                if (this._emptySpaceAnchor === anchor)
                    this._emptySpaceAnchor = null;
                if (this._emptySpaceMenu === m) {
                    this._emptySpaceMenu = null;
                    this._emptySpaceMenuOpenId = 0;
                }
            }
        });

        Main.uiGroup.add_child(menu.actor);
        const menuManager = new PopupMenu.PopupMenuManager(anchor);
        menuManager.addMenu(menu);

        this._emptySpaceMenu = menu;
        menu.open(BoxPointer.PopupAnimation.FULL);
    }

    disable() {
        this._enabled = false;

        for (const [icon, handlerId] of this._folderIconSignals) {
            if (icon._menu) {
                Main.overview.disconnectObject(icon._menu);
                if (icon._openStateChangedId) {
                    icon._menu.disconnect(icon._openStateChangedId);
                    icon._openStateChangedId = 0;
                }
                icon._menu.actor.destroy();
                icon._menu = null;
                icon._menuManager = null;
            }
            icon.disconnect(handlerId);
            icon.set_scale(1, 1);
            icon.opacity = 255;
        }
        this._folderIconSignals.clear();

        for (const [parentView, handlerId] of this._viewLoadedConnections)
            parentView.disconnect(handlerId);
        this._viewLoadedConnections.clear();

        FolderIcon.prototype._init = this._origInit;
        FolderIcon.prototype.popupMenu = this._origPopupMenu;
        FolderIcon.prototype._onFolderMenuPoppedDown = this._origOnPoppedDown;

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

        if (this._groupAnimIcons) {
            for (const icon of this._groupAnimIcons) {
                icon.set_scale(1, 1);
                icon.opacity = 255;
            }
            this._groupAnimIcons = null;
        }

        if (this._groupButton && this._groupButtonClickedId) {
            this._groupButton.disconnect(this._groupButtonClickedId);
            this._groupButtonClickedId = 0;
        }
        if (this._cancelButton && this._cancelButtonClickedId) {
            this._cancelButton.disconnect(this._cancelButtonClickedId);
            this._cancelButtonClickedId = 0;
        }

        if (this._selectBar) {
            this._selectBar.destroy();
            this._selectBar = null;
        }

        if (this._dashAllocId && Main.overview?.controls?.dash) {
            Main.overview.controls.dash.disconnect(this._dashAllocId);
            this._dashAllocId = 0;
        }

        if (this._emptySpaceMenu) {
            if (this._emptySpaceMenuOpenId)
                this._emptySpaceMenu.disconnect(this._emptySpaceMenuOpenId);
            this._emptySpaceMenu.actor.destroy();
            this._emptySpaceMenu = null;
            this._emptySpaceMenuOpenId = 0;
        }

        if (this._emptySpaceAnchor) {
            this._emptySpaceAnchor.destroy();
            this._emptySpaceAnchor = null;
        }
    }
}
