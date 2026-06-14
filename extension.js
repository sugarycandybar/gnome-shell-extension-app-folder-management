import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const FolderIcon = AppDisplay.FolderIcon;

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
        this._origInit = FolderIcon.prototype._init;

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

        this._stageHandlerId = global.stage.connect('button-press-event',
            (actor, event) => {
                if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                    return Clutter.EVENT_PROPAGATE;

                let target = global.stage.get_event_actor(event);
                if (!target)
                    return Clutter.EVENT_PROPAGATE;

                for (let icon = target; icon; icon = icon.get_parent()) {
                    if (icon instanceof FolderIcon) {
                        icon.popupMenu();
                        return Clutter.EVENT_STOP;
                    }
                }

                return Clutter.EVENT_PROPAGATE;
            });
    }

    disable() {
        FolderIcon.prototype._init = this._origInit;
        FolderIcon.prototype.popupMenu = function () {};
        FolderIcon.prototype._onFolderMenuPoppedDown = function () {};

        if (this._stageHandlerId) {
            global.stage.disconnect(this._stageHandlerId);
            this._stageHandlerId = 0;
        }
    }
}
