const AboutURL = "https://github.com/dhowe/AdNauseam/wiki/FAQ";
const VaultMan = require("./vaultman").VaultManager;
const Options = require("./options").Options;
const Util = require('./adnutil').AdnUtil;
const Timers = require("sdk/timers");
const Data = require("sdk/self").data;
const Tabs = require("sdk/tabs");

const { Cc, Ci, Cu } = require("chrome");
const OS = Cu.import("resource://gre/modules/osfile.jsm", {}).OS;

var UIManager = require('sdk/core/heritage').Class({

  cfx: null,
  menu: null,
  button: null,
  worker: null,
  firstRun: false,

  initialize: function() {

    //Util.log('UIManager()');

    this.cfx = !!require('sdk/system/environment').env.ADN_DEV || false;

    if (this.cfx) {

      require("sdk/preferences/service")
        .set("javascript.options.strict", false);
    }

    this.button = require('sdk/ui/button/toggle').ToggleButton({

      id: "adnauseam-button",
      label: "AdNauseam",
      icon: this.buttonIconSet(false),
      onChange: this.handleChange.bind(this),
    });
    
    var locale = require("sdk/l10n").get;
    this.menu = require("sdk/panel").Panel({
      
      contentURL: Data.url("menu.html"),

        contentScriptOptions: {

          'locale': {
            "Disable all logging": locale("adn.menu.settings.tooltip.disableAllLogging"),
            "Disable outgoing referrer": locale("adn.menu.settings.tooltip.disableOutgoingReferrer"),
            "Clear Ads with browser history": locale("adn.menu.settings.tooltip.clearAds"),
            "Hide Ad count on icon": locale("adn.menu.settings.tooltip.hideBadge"),
            "Export Ads": locale("adn.menu.settings.tooltip.exportAds"),
            "Import Ads": locale("adn.menu.settings.tooltip.importAds")
          }
        },

      contentScriptFile: [
        Data.url("lib/jquery-2.1.4.min.js"),
        Data.url("../lib/ff/adnutil.js"),
        Data.url('shared.js'),
        Data.url("menu.js")
      ],

      // contentScriptOptions:{}, // available as self.options

      onHide: this.closeMenu.bind(this),
      onShow: this.openMenu.bind(this)
    });

    this.registerEventHandlers();
  },

  updateOnAdAttempt: function(ad) {

    //Util.log('UIMan.updateOnAdAttempt('+ad.id+')');

    this.menuIsOpen() && this.menu.port.emit("set-current", {
      current: ad
    });

    VaultMan.onAdAttempt(ad);
  },

  updateOnAdVisit: function(update) {

    require("./adncomp").Component.parser.needsWrite = true;
    this.animateIcon(500);
    this.updateMenu(update);

    VaultMan.onAdVisit(update);
  },

  updateOnAdFound: function() {

    require("./adncomp").Component.parser.needsWrite = true;

    // just reset the full view here
    this.updateMenu();
    this.animateIcon(500);

    VaultMan.onAdFound();
  },

  animateIcon: function(ms) {

    this.button.icon = this.buttonIconSet(true);
    Timers.setTimeout(function() {

      this.button.icon = this.buttonIconSet(false);

    }.bind(this), ms);
  },

  startCountInserter: function() {

//getLogger().log("UIman.startCountInserter()");

    var me = this;

    this.workers = [];

    require("sdk/page-mod").PageMod({

      include: "*",

      attachTo: 'top', // no iframes here

      contentScriptFile: [
        Data.url('lib/jquery-2.1.4.min.js'),
        Data.url('count-inserter.js')
      ],

      contentScriptWhen: "start",

      onAttach: function(worker) {

//getLogger().log("UIman.onAttach: ");

        me.workers.push(worker); // keep track of the workers

        worker.on('detach', function() {

          var index = me.workers.indexOf(this);
          if (index != -1) me.workers.splice(index, 1);
        });
      }
    });
  },

  injectCountOnPage: function(workers) { // count and color

    var count, mapEntry,
      pageUrl = this.currentPage(),
      prefs = require('sdk/simple-prefs').prefs,
      parser = require("./adncomp").Component.parser;

    if (!/^http/.test(pageUrl)) return;

    mapEntry = parser.pageMapLookup(pageUrl);
    count = (mapEntry && mapEntry.ads.length) ? mapEntry.ads.length : 0;

    if (!workers) this.startCountInserter();

    if (count && workers) {

      for (var i = 0, len = workers.length; i < len; i++) {

        if (workers[i].url === pageUrl && workers[i].port)
          workers[i].port.emit('insert-count', { 'count': count });
      }
    }
  },

  updateBadge: function() { // count and color

    // this pref is set by the selenium harness for testing
    if (require('sdk/simple-prefs').prefs["automated"]) {

      this.injectCountOnPage(this.workers);
    }

    if (Options.get('hideBadge') || !Options.get('enabled')) {

      this.button.badge = null;
      return;
    }

    var mapEntry, parser = require("./adncomp").Component.parser;

    if (parser.checkVersion("36")) {

      mapEntry = parser.pageMapLookup(this.currentPage());

      try {

        if (mapEntry && mapEntry.ads.length) {

          this.button.badge = mapEntry.ads.length;
          this.button.badgeColor = this.badgeColor(mapEntry.ads);

        } else {

            this.button.badge = null;
        }
      }
      catch (e) {

        // ignore error on badge-update when shutting down...
      }
    }
  },

  badgeColor: function(ads) {

    function failedCount(ads) {

      return ads.filter(function(d) {
        return d.visitedTs < 0;
      }).length;
    }

    function visitedCount(ads) {

      return ads.filter(function(d) {
        return d.visitedTs > 0;
      }).length;
    }

    if (visitedCount(ads)) return '#BD10E0';
    return (failedCount(ads)) ? '#B80606' : '#0076FF';
  },

  updateMenu: function(update) {

    if (this.menuIsOpen()) {

      var parser = require("./adncomp").Component.parser,
        current = parser.visitor.currentAd,
        pageUrl = this.currentPage(),
        menuAds = this.getMenuAds(parser, pageUrl),
        json;

      //Util.log('uiman::updateMenu().current: '+(current ? current.id : -1));

      if (update) {

        this.menu.port.emit("update-ad", {

          update: update,
          page: pageUrl,
          current: null // no longer being attempted

        }); // -> from menu.js

      } else {

        if (Options.get('enabled')) {

          var locale = require("sdk/l10n").get,
            msgNoAds = locale("adn.menu.alert.noAds"),
            win = require("sdk/window/utils").getMostRecentBrowserWindow();

          if (require("sdk/private-browsing").isPrivate(win))
            msgNoAds = locale("adn.menu.alert.private");
          else if (!menuAds.count && parser.adlist.length) {

            // no page-ads, only recent
            msgNoAds += ' ' + locale("adn.menu.alert.recent");
          }

          json = {

            page: pageUrl,
            current: current,
            totalCount: parser.adlist.length,
            data: menuAds.ads, // either actual or 'recent' ads
            pageCount: menuAds.count, // actual-ads length
            emptyMessage: msgNoAds // localized msg
          };
        }

        //Util.log('Enabled='+Options.get('enabled')+
        //  '->emit("layout-ads") :: '+(json ? json.pageCount : 0));

        this.menu.port.emit("layout-ads", json); // -> from menu.js
      }
    }

    this.updateBadge();
  },

  getMenuAds: function(parser, pageUrl) {

    var byField = require('./adnutil').AdnUtil.byField,
      pmEntry = parser.pageMapLookup(pageUrl),
      ads = (pmEntry && pmEntry.ads),
      count = 0;

    if (ads && ads.length) {

      ads.sort(byField('-foundTs')); // sort by found-time
      count = ads.length;

    } else {

      ads = this.recentAds(parser, byField);
    }

    return {

      ads: ads,
      count: count
    };
  },

  recentAds: function(parser, byField) {

    var recent = [],
      ads = parser.adlist,
      num = 5;

    ads.sort(byField('-foundTs'));

    for (var i = 0; recent.length < num && i < ads.length; i++)
      recent.push(ads[i]); // put pending ads first

    if (parser.visitor.currentAd && parser.visitor.currentAd.visitedTs === 0) {

      ads.unshift(parser.visitor.currentAd);
      ads.pop();
    }

    return recent;
  },

  menuIsOpen: function() {

    return (this.menu && this.menu.isShowing);
  },

  currentPage: function() {

    var pageUrl = Tabs.activeTab.url;

    var tm = require('../config').PARSER_TEST_MODE;
    if (tm) {
      if (tm == 'insert' || tm == 'update') {
        pageUrl = require('../config').PARSER_TEST_PAGE;
        require("./adnutil").AdnUtil.log("*TEST*: Using test.pageUrl: " +
          pageUrl);
      }
    }

    return pageUrl;
  },

  openMenu: function() {

    this.updateMenu();
  },

  cleanupTabs: function() {

    var inDataDir = new RegExp('^' + Data.url());

    for (var tab of Tabs) {

      if (inDataDir.test(tab.url) || tab.url.contains("log.html") ||
        tab.url.contains(getLogger().fileName)) {

        // handle issue #333 here, checking if last tab
        if (Tabs.length == 1)
          tab.url = "about:blank";
        else
          tab.close();
      }
    }
  },

  tabsContain: function(match) {

    for (var tab of Tabs) {

      if (tab.url === match)
        return true;
    }
    return false;
  },

  refreshMenu: function() {

    var opts = Options.toJSON(),
      locale = require("sdk/l10n").get;

    opts.startLabel = locale("adn.menu.start");
    opts.pauseLabel = locale("adn.menu.pause");

    this.menu.port.emit("refresh-panel", opts);
    this.button.icon = this.buttonIconSet();
    this.updateBadge();
  },

  handleChange: function(state) {

    if (state.checked) { // button is clicked

      Timers.setTimeout(function () {
        
        this.menu.show({

          position: this.button,
          width: 387,
          height: 500,
        });
      }.bind(this), 100);
    }

    this.updateMenu();
    this.refreshMenu();
  },

  openFirstRun: function(state) {

    getLogger().log('UIManager.openFirstRun');

    var panel = require("sdk/panel").Panel({

      width: 387,
      height: 500,
      position: this.button,
      contentURL: require("sdk/self").data.url("firstrun.html"),

      contentScriptFile: [

        Data.url("lib/jquery-2.1.4.min.js"),
        Data.url("firstrun.js")
      ],

      contentScriptOptions: {

        version: require("sdk/self").version
      }
    });

    panel.port.on('close-firstrun', function() {

      panel.hide();
      panel.destroy();
      panel = null;
    });

    // TODO: verify ads in storage here??

    panel.show();
  },

  buttonIconSet: function(pressed) {

    return {

      "16": this.buttonIcon(16, pressed),
      "32": this.buttonIcon(32, pressed),
      "64": this.buttonIcon(64, pressed)
    };
  },

  buttonIcon: function(size, pressed) {

    return Options.get('enabled') ?
      (pressed ? Data.url('img/icon-v-' + size + '.png') :
        Data.url('img/icon-' + size + '.png')) :
      Data.url('img/icon-g-' + size + '.png');
  },

  closeMenu: function() {

    this.button.state('window', {
      checked: false
    }); // required

    this.menu.port.emit("close-panel");
  },

  registerEventHandlers: function() {

    // registering menu event-handlers here
    this.menu.port.on("clear-ads", function(data) {

      getLogger().log('UI->clear-ads');
      require("./adncomp").Component.parser.clearAds();
      VaultMan.closeVault();
      this.updateBadge();

    }.bind(this));

    this.menu.port.on("import-ads", function(data) {

      getLogger().log('UI->import-ads');
      this.importAds();
      VaultMan.openVault();

    }.bind(this));

    this.menu.port.on("export-ads", function(data) {

      getLogger().log('UI->export-ads');
      this.exportAds();

    }.bind(this));

    this.menu.port.on("show-vault", function() {

      getLogger().log('UI->show-vault');
      this.menu.hide();
      VaultMan.openVault();

    }.bind(this));

    this.menu.port.on("toggle-enabled", function() {

      getLogger().log('UI->toggle-enabled');
      Options.toggle('enabled');
      this.updateMenu();

    }.bind(this));

    this.menu.port.on("disable-logs", function(arg) {

      var value = (arg && arg.value);
      getLogger().log('UI->disable-logs: ' + value);
      Options.set('disableLogs', value);

      // If user disables logging, delete their log file (not on windows, see #384)
      var Logger = getLogger();
      if (value) {

        if (require("sdk/system").platform!=='winnt') {
          Logger.dispose();
        }
        else
          Logger.closeLog();
      }

    }.bind(this));

    this.menu.port.on("disable-referer", function(arg) {

      var value = (arg && arg.value);
      getLogger().log('UI->disable-referer: ' + value);
      Options.set('disableOutgoingReferer', value);

    }.bind(this));

    this.menu.port.on("clear-ads-with-history", function(arg) {

      var value = (arg && arg.value);
      getLogger().log('UI->clear-ads-with-history: ' + value);
      Options.set('clearAdsWithHistory', value);

    }.bind(this));

    this.menu.port.on("hide-badge", function(arg) {

      var value = (arg && arg.value);
      getLogger().log('UI->hide-badge: ' + value);
      Options.set('hideBadge', value);
      this.updateBadge();

    }.bind(this));

    this.menu.port.on("show-about", function() {

      getLogger().log('UI->show-about');

      this.menu.hide();

      Tabs.open(AboutURL);

    }.bind(this));

    this.menu.port.on("show-log", function() {

      this.menu.hide();

      var Logger = getLogger();

      if (Options.get('disableLogs') || !Logger.ostream) {

        var locale = require("sdk/l10n").get;
        Logger.notify(locale("adn.notification.noLog"));

      } else {

        Logger.log('UI->show-log');
        Logger.openLog();
      }

    }.bind(this));
  },

  importAds: function(theFile) {

    var picker, parser = require("./adncomp").Component.parser;

    try {
      if (!theFile) { // open a prompt

        picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
        picker.init(require("sdk/window/utils").getMostRecentBrowserWindow(),
          "Import Ads", Ci.nsIFilePicker.modeOpen);

        picker.appendFilters(Ci.nsIFilePicker.filterAll);

        if (picker.show() == Ci.nsIFilePicker.returnOK)
          theFile = picker.file;
      }

      if (theFile) {

        var Logger = getLogger();

        Logger.log("Ad-import from: " + theFile.path);

        var promise = OS.File.read(theFile.path, { encoding: "utf-8" });

        promise = promise.then(function onSuccess(data) {

          var ads = JSON.parse(data);
          //console.log(ads.length+' ads');
          parser.doImport(ads);
          parser.logStats();

        }, Logger.error.bind(Logger));
      }
    }
    catch(e) {
      getLogger().error('Error on import', e);
    }
  },

  exportAds: function() {

    var rv, version = require("sdk/self").version,
      parser = require("./adncomp").Component.parser,
      data = JSON.stringify(parser.adlist, null, '  '),
      picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);

    picker.defaultString = 'adnauseam-v' + version + '-exported-ads.json';
    picker.init(require("sdk/window/utils").getMostRecentBrowserWindow(),
      "Export Ads", Ci.nsIFilePicker.modeSave);

    picker.appendFilter("JavaScript Object Notation (JSON)", "*.json");

    rv = picker.show();

    if (rv == Ci.nsIFilePicker.returnOK || rv == Ci.nsIFilePicker.returnReplace) {

      getLogger().log("Ad-export to: " + picker.file.path);

      var writePath = picker.file.path;

      var promise = OS.File.writeAtomic(writePath, data, {
        tmpPath: writePath + '.tmp'
      });

      promise.then(
        function(aVal) {
          getLogger().log('Saved to file');
        },
        function(aReason) {
          getLogger().log('writeAtomic failed: ', aReason);
        }
      );
    }
  }
});

function getLogger() { return require("./logger").Logger; }

exports.UIManager = UIManager();
