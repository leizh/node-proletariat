"use strict";

var
	events		= require('events'),
	util		= require('util'),
	net		= require('net'),
	Stream		= require('./stream').stream.Stream,

	SLOTS		 = 10,
	CLEANUP_REQS	 = 100,
	CLEANUP_CHECKINT = 5000,
	CON_RETRYTIME	 = 2000,

	seq = 1;


/*
 * Agent
 *
 * constructor:
 *
 *   new Agent()
 *
 * methods:
 *
 *   - start()
 *   - stop()
 *
 * events:
 *
 *   - work(work)
 *   - error(err)
 *   - close()
 */

function Agent(opts) {

	var
		self = this;

	// Options

	if ( opts == null )
		opts = { };

	// Variable properties

	this.maxSlots		= opts.slots || SLOTS;
	this.host		= opts.host || "127.0.0.1";
	this.CLEANUP_REQS	= opts.CLEANUP_REQS || CLEANUP_REQS;
	this.CLEANUP_CHECKINT	= opts.CLEANUP_CHECKINT || CLEANUP_CHECKINT;
	this.CON_RETRYTIME	= opts.CON_RETRYTIME || CON_RETRYTIME;
	this.ANSWER_THRESHOLD	= opts.ANSWER_THRESHOLD || parseInt(opts.slots*0.25);

	// Fixed properties

	this.id			= seq++;
	this.s			= null;
	this.status		= "offline";
	this.stream		= null;
	this.lastCommand	= null;
	this.finishCount	= 0;
	this.isClean		= true;
	this.availableSlots	= this.maxSlots;

	// Data support

	this.workingQueue	= {};
	this.answerList		= [];

	this.resultCache	= { };

	// Methods

	this.start = agentStart;
	this.stop = agentStop;
	this.finishWork = _agentFinishWork;
	this._agentConnect = _agentConnect;
	this._agentStartBiz = _agentStartBiz;
	this._agentReceiveWork = _agentReceiveWork;
	this._agentOnMessage = _agentOnMessage;
	this._agentOnError = _agentOnError;
	this._agentOnDisconnect = _agentOnDisconnect;
	this._command = _command;
	this._send = _send;
	this._cleanup = _cleanup;
	this._cleanupProcess = _cleanupProcess;

	this._cleanupInterval = setInterval(function(){self._cleanupProcess()},this.CLEANUP_CHECKINT);

}
util.inherits(Agent, events.EventEmitter);


// Start agent

function agentStart() {

	_debug("[agent #"+this.id+"] Starting (manager: "+this.host+")");

	return this._agentConnect();

}

function _agentConnect() {

	var
		self = this;

	self.s = net.connect({host: self.host, port: 1917}, function(){
		_debug("[agent #"+self.id+"] Connected to comrade manager");
		self.status = "online";
		self.stream = new Stream("string",self.s);
		self.stream.on('message',function(m){self._agentOnMessage(m)});
		self.stream.on('error',function(err){self._agentOnError(err)});
		self.stream.on('close',function(){self._agentOnDisconnect()});
		self._agentStartBiz();
	});
	self.s.on('error',function(err){
		if ( err.code ) {
			if ( err.code == "ECONNREFUSED" ) {
				_debug("Could not connect to manager. Retrying in "+self.CON_RETRYTIME+"ms...");
				return setTimeout(function(){
					return self._agentConnect();
				}, self.CON_RETRYTIME);
			}
		}
		else {
			_debug("No error code, ignoring by logging: "+err.toString());
		}
	});

}

// Start business here

function _agentStartBiz() {

	// Offer our slots

	_debug("[agent #"+this.id+"] Offering "+this.availableSlots+" slots");
	this._command("offer",{slots: this.availableSlots});

}


// Stop manager

function agentStop() {

	this.s.close();
	this.s = null;
	_debug("[agent #"+self.id+"] остановившийся!");

}


// Handle message (highlevel stuff)

function _agentOnMessage(msg) {

	var
		self = this,
		m;

	try {
//		_debug("> "+msg.toString('utf8'));
		m = JSON.parse(msg.toString('utf8'));
	}
	catch(ex) {
		_debug("[agent #"+self.id+"] Is comrade manager drunk or what? Got invalid JSON. Ignoring message: ",ex);
		return;
	}

	// Answer to my requests

	if ( m.command == "answer" ) {

		if ( m.to == "offer" ) {

			if ( self.lastCommand != "offer" ) {
				_debug("[agent #"+self.id+"] Comrade manager is answering me to offer but i didn't make any offer, ignoring..");
				return;
			}

			if ( m.error ) {
				_debug("[agent #"+self.id+"] Comrade manager didn't accept my offer. I will try later.");
				return setTimeout(function(){
					self._command("offer",{slots: self.availableSlots});
				},1000);
			}

			if ( m.you != null )
				self.id = m.you;

			self.status = "work";
			_debug("[agent #"+self.id+"] Got OK from comrade manager as answer to 'offer' command. I will be waiting for work...");
		}
		else if ( m.to == "ping" ) {
			_debug("[agent #"+self.id+"] Comrade manager answered to ping request: ",m);
		}
		else if ( m.to == "done" ) {
			_debug("[agent #"+self.id+"] Comrade manager answered to my 'done': "+m.description);
		}
		else {
			_debug("Answer to something that I don't know");
		}
		return;
	}

	// Commands

	else {

		// Work push

		if ( m.command == "push" ) {

			return self._agentReceiveWork(m.work);

		}

	}

}


// Receive work

function _agentReceiveWork(works) {

	var
		self = this,
		workIDs = [],
		workByID = {};

	if ( !(works instanceof Array) ) {
		_debug("[agent #"+self.id+"] Got work but it is not an Array.. hmn, discarding..");
		return self._command("answer",{ to: "push", error: { code: "EINVWORK", description: "Invalid work ?array?" } });
	}


	// What jobs can i accept and what i need to reject ?

	var
		acceptedWorks = [],
		rejectedWorks = [];

	works.forEach(function(w){
		if ( w.id == null )
			return;
		workByID[w.id] = w;

		if ( w.args == null || acceptedWorks.length >= self.availableSlots )
			return rejectedWorks.push(w.id);

		acceptedWorks.push(w.id);
	});

	// Got work, let's push it into the queue and work!

	acceptedWorks.forEach(function(id){
		var w = workByID[id];
		_debug("[agent #"+self.id+"] Got a new work: "+w.id);
		self.workingQueue[w.id] = w;
		self.availableSlots--;

		// If the arguments is a function, eval it

		if ( typeof(w.args) == "object" && w.args._Fn && w.args._code ) {
			var _Fn = {};
			w.args = eval(w.args._code.replace(/^function\s+/,"_Fn['"+w.id+"'] = function "));
		}
	});

	// Answer

	var
		a = { to: "push" };

	if ( acceptedWorks.length > 0 ) {
		a.accepted = acceptedWorks;
		a.description = "i'll do my best";
	}
	if ( rejectedWorks.length > 0 ) {
		_debug("[agent #"+self.id+"] REJECTED "+rejectedWorks.length+" works");
		a.rejected = rejectedWorks;
		a.description = "some works were rejected";
		a.allocation = { was: self.availableSlots+acceptedWorks.length, is: self.availableSlots, rejected: rejectedWorks.length, got: works.length };
	}

	self._command("answer",a);


	// Emit 'work' events for accepted works

	acceptedWorks.forEach(function(id){
		self.emit('work',self.workingQueue[id],function(err,data){
			self.finishWork(self.workingQueue[id],{err: err, data: data});
		});
	});

}


// Finish a work

function _agentFinishWork(w,result) {

	var
		self = this;

	if ( !w ) {
		_debug("This work has already finish. Watch your handlers");
		return;
	}
	if ( !w.id )
		throw new Error("Finished job has no id!");

	_debug("[agent #"+self.id+"] Finished job "+w.id);

	// If we are offline, forget!

	if ( self.status == "offline" ) {
		_debug("[agent #"+self.id+"] Doing nothing because I'm offline");
		return;
	}

	// Assign the result to the work

	w.result = result;

	// Delete from working queue and free some slots

	self.isClean = false;
	self.workingQueue[w.id] = null;
//	delete self.workingQueue[w.id];
	self.availableSlots++;

	// FIXME: for sending results back to manager, the manager need to know that we are the same client
	//	(for not accepting results from every client, so we have to implement something like session ID's)
	// I am offline ? Keep on results cache for sending later to the manager
	//
	//if ( self.status == "offline" ) {
	//	self.resultCache[w.id] = w;
	//	setTimeout(function(){
	//		_debug("[agent #"+self.id+"] Work #"+w.id+" result was put on the garbage (we couldn't send to manager)");
	//		delete self.resultCache[w.id];
	//	},60000
	//	return;
	//}


	// Answer

	self.answerList.push({id: w.id, result: w.result });

	if ( self.answerList.length >= self.ANSWER_THRESHOLD || self.availableSlots == self.maxSlots ) {
		self._command("done",{work: self.answerList});
		self.answerList = [];
	}

	// Cleanup ?

	if ( (++self.finishCount % self.CLEANUP_REQS) == 0 ) {
		self.finishCount = 0;
		self._cleanup();
	}
	else {
		if ( self.availableSlots == self.maxSlots )
			self.canCleanup = true;
	}

}


// Error ?

function _agentOnError(err) {
	_debug("[agent #"+this.id+"] Got error: ",err);
}

// Disconnect ?

function _agentOnDisconnect() {

	var
		self = this;

	_debug("[agent #"+this.id+"] Comrade manager disconnected, reseting and reconnecting in "+self.CON_RETRYTIME+"ms...");

	this.status = "offline";

	// FIXME: We should implement session keeping, instead of reseting everything
	this.workingQueue = {};
	this.availableSlots = this.maxSlots;

	setTimeout(function(){
		self._agentConnect();
	}, self.CON_RETRYTIME);

}


// Tell things to a client

function _send(obj) {

	if ( this.status == "offline" )
		return;

//	_debug("< ",JSON.stringify(obj));
	return this.stream.sendMessage(JSON.stringify(obj));
}
function _command(command,args) {
	var
		o = args || { };

	this.lastCommand = command;
	o.command = command;
	this._send(o);
}
function _ok() {
	return this._send({ ok: true });
}
function _error(error) {
	return this._send({ error: error });
}

// Debug

function _debug() {
/*
	var
		args = [_nsec([])];

	for ( var x = 0 ; x < arguments.length ; x++ )
		args.push(arguments[x]);

	console.log.apply(null,args);
*/
}

function _nsec(start) {

	var
		diff = process.hrtime(start);

	return (diff[0] * 1e9 + diff[1]) / 1000000;

}


// Cleanup


function _cleanupProcess() {

	_debug("[agent #"+this.id+"] Available: "+this.availableSlots);

	if ( this.availableSlots < 0 ) 
		throw new Error("NEGATIVE availableSlots");
	if ( this.canCleanup && this.availableSlots == this.maxSlots && !this.isClean )
		return this._cleanup();

}
function _cleanup() {

	var
		self = this,
		lists = [this.workingQueue];

	_debug("[agent #"+this.id+"] CLEANUP");

	lists.forEach(function(list){
	 	for ( var k in list ) {
	 		if ( list[k] == null )
	 			delete list[k];
	 	}
	});

	self.isClean = true;

}

// Self object

exports.agent = {
	Agent: Agent
};