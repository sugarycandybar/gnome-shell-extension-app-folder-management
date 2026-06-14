import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const FolderIcon = AppDisplay.FolderIcon;

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

        this.close();
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
