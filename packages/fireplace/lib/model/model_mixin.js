require('fireplace/transforms');

require('fireplace/relationships/relationships_mixin');

require('fireplace/model/live_mixin');
require('fireplace/model/attributes_mixin');
require('fireplace/model/mutable_snapshot');

var get       = Ember.get,
    set       = Ember.set,
    cacheFor  = Ember.cacheFor,
    isNone    = Ember.isNone,
    serialize = FP.Transform.serialize;

FP.ModelClassMixin = Ember.Mixin.create(FP.AttributesClassMixin, FP.RelationshipsClassMixin);

FP.ModelMixin = Ember.Mixin.create(FP.LiveMixin, FP.AttributesMixin, FP.RelationshipsMixin, Ember.Evented, {
  firebaseEvents: ['child_added', 'child_removed', 'child_changed', 'value'],

  store: null,

  isNew: Ember.computed(function(){
    return !get(this, "_snapshot");
  }).property("_snapshot"),

  // the actual Firebase::Snapshot, can be null if new record
  _snapshot: null,

  // wrapped MutableSnapshot, will never be null
  snapshot: Ember.computed(function(key, value) {
    var snapshot;
    if (arguments.length > 1) {
      set(this, "_snapshot", value);
      snapshot = value;
    } else {
      snapshot = get(this, "_snapshot");
    }
    return new FP.MutableSnapshot(snapshot);
  }).property("_snapshot"),

  willDestroy: function() {
    var store = get(this, "store");
    store.teardownRecord(this);

    var parent = get(this, "parent"),
        parentKey = get(this, "parentKey");

    // TODO - remove this knowledge from here
    // Ember data does this with registered collections etc...
    if (parent && !parent.isDestroyed && !parent.isDestroying) {
      if (parent && parentKey) {
        set(parent, parentKey, null);
      } else {
        parent.removeObject(this);
      }
    }

    this._super();
  },

  eachActiveRelation: function(cb) {
    var item;
    get(this.constructor, 'relationships').forEach(function(name, meta) {
      item = cacheFor(this, name);
      if (item) { cb(item); }
    }, this);
  },

  listenToFirebase: function() {
    if (!get(this, 'isListeningToFirebase')) {
      this.eachActiveRelation(function(item) {
        item.listenToFirebase();
      });
    }
    return this._super();
  },

  stopListeningToFirebase: function() {
    if (get(this, 'isListeningToFirebase')) {
      this.eachActiveRelation(function(item) {
        item.stopListeningToFirebase();
      });
    }
    return this._super();
  },

  setAttributeFromSnapshot: function(snapshot, valueRemoved) {
    var key       = snapshot.name();
    var attribute = this.attributeNameFromKey(key);
    if (!attribute) { return; }

    var current     = get(this, "snapshot"),
        currentData = current.val(),
        newVal;

    // child_removed sends the old value back in the snapshot
    if (valueRemoved) {
      newVal = null;
    } else {
      newVal = snapshot.val();
    }

    // don't bother triggering a property change if nothing has changed
    // eg if we've got a snapshot & then started listening
    if (currentData.hasOwnProperty(key) && currentData[key] === newVal) {
      return;
    }

    current.set(key, newVal);

    this.settingFromFirebase(function(){
      this.notifyPropertyChange(attribute);
    });
  },

  notifyRelationshipOfChange: function(snapshot, valueRemoved) {
    var key       = snapshot.name();
    var attribute = this.relationshipNameFromKey(key);

    if (!attribute) { return; }

    // child_removed sends the old value back in the snapshot
    var newVal;
    if (valueRemoved) {
      newVal = null;
    } else {
      newVal = snapshot.val();
    }

    get(this, "snapshot").set(key, newVal);

    var meta = this.constructor.metaForProperty(attribute);
    if (meta.kind === "hasOne") {
      this.settingFromFirebase(function(){
        this.notifyPropertyChange(attribute);
      });
    }
  },

  onFirebaseChildAdded: function(snapshot) {
    this.setAttributeFromSnapshot(snapshot);
    this.notifyRelationshipOfChange(snapshot);
  },

  onFirebaseChildRemoved: function(snapshot) {
    this.setAttributeFromSnapshot(snapshot, true);
    this.notifyRelationshipOfChange(snapshot, true);
  },

  onFirebaseChildChanged: function(snapshot) {
    this.setAttributeFromSnapshot(snapshot);
    this.notifyRelationshipOfChange(snapshot);
  },

  onFirebaseValue: function(snapshot) {
    // apparently we don't exist
    if (snapshot && !snapshot.val()) {
      this.destroy();
    } else {
      set(this, "_snapshot", snapshot);
    }
  },

  update: function(key, value) {
    set(this, key, value);
    return this.save(key);
  },

  save: function(key) {
    return get(this, 'store').saveRecord(this, key);
  },

  delete: function() {
    return get(this, 'store').deleteRecord(this);
  },

  toFirebaseJSON: function(includePriority) {
    var attributes    = get(this.constructor, 'attributes'),
        relationships = get(this.constructor, 'relationships'),
        container     = get(this, "container"),
        snapshot      = get(this, "_snapshot"),
        json          = {},
        key, value;

    attributes.forEach(function(name, meta){
      value = get(this, name);
      // Firebase doesn't like null values, so remove them
      if (isNone(value)) { return; }

      json[this.attributeKeyFromName(name)] = serialize(this, value, meta, container);
    }, this);

    relationships.forEach(function(name, meta){
      // we don't serialize detached relationships
      if (meta.options.detached) { return; }

      key = this.relationshipKeyFromName(name);

      // if we haven't loaded the relationship yet, get the data from the snapshot
      // no point materializing something we already know the data of
      value = cacheFor(this, name);

      if (value === undefined && snapshot) {
        value = snapshot.child(key).exportVal();
      } else if (isNone(value)) {
        // Firebase doesn't like null values, so remove them
        return;
      } else {
        // TODO - ideally we shouldn't have to know about these details here
        // can we farm this off to a function on the relationship?
        if (meta.kind === "hasOne" && meta.options.embedded === false) {
          value = get(value, "id");
        } else {
          value = value.toFirebaseJSON(true);
        }
      }

      json[key] = value;
    }, this);

    return includePriority ? this.wrapValueAndPriority(json) : json;
  },

  wrapValueAndPriority: function(json) {
    var priority = get(this, 'priority');
    if (isNone(priority)) {
      return json;
    }

    return {
      '.value':    json,
      '.priority': priority
    };
  }

});