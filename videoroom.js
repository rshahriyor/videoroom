// We import the settings.js file to know which address we should contact
// to talk to Janus, and optionally which STUN/TURN servers should be
// used as well. Specifically, that file defines the "server" and
// "iceServers" properties we'll pass when creating the Janus session.

/* global iceServers:readonly, Janus:readonly, server:readonly */

var janus = null;
var sfutest = null;
var opaqueId = "videoroomtest-"+Janus.randomString(12);

var myroom = 0;	// Demo room
if(getQueryStringValue("room") !== "")
	myroom = parseInt(getQueryStringValue("room"));
var myusername = null;
var myid = null;
var mystream = null;
// We use this other ID just to map our subscriptions to us
var mypvtid = null;

var localTracks = {}, localVideos = 0;
var feeds = [], feedStreams = {};
var bitrateTimer = [];

var doSimulcast = (getQueryStringValue("simulcast") === "yes" || getQueryStringValue("simulcast") === "true");
var doSvc = getQueryStringValue("svc");
if(doSvc === "")
	doSvc = null;
var acodec = (getQueryStringValue("acodec") !== "" ? getQueryStringValue("acodec") : null);
var vcodec = (getQueryStringValue("vcodec") !== "" ? getQueryStringValue("vcodec") : null);
var doDtx = (getQueryStringValue("dtx") === "yes" || getQueryStringValue("dtx") === "true");
var subscriber_mode = (getQueryStringValue("subscriber-mode") === "yes" || getQueryStringValue("subscriber-mode") === "true");
var use_msid = (getQueryStringValue("msid") === "yes" || getQueryStringValue("msid") === "true");

$(document).ready(function() {
	// Initialize the library (all console debuggers enabled)
	Janus.init({debug: "all", callback: function() {
		// Use a button to start the demo
		$('#start').one('click', function() {
			$(this).attr('disabled', true).unbind('click');
			// Make sure the browser supports WebRTC
			if(!Janus.isWebrtcSupported()) {
				bootbox.alert("No WebRTC support... ");
				return;
			}
			// Create session
			janus = new Janus(
				{
					server: 'http://185.221.214.97:8088/janus',
					iceServers: iceServers,
					// Should the Janus API require authentication, you can specify either the API secret or user token here too
					//		token: "mytoken",
					//	or
					//		apisecret: "serversecret",
					success: function() {
						// Attach to VideoRoom plugin
						janus.attach(
							{
								plugin: "janus.plugin.videoroom",
								opaqueId: opaqueId,
								success: function(pluginHandle) {
									$('#details').remove();
									sfutest = pluginHandle;
									Janus.log("Plugin attached! (" + sfutest.getPlugin() + ", id=" + sfutest.getId() + ")");
									Janus.log("  -- This is a publisher/manager");
									$('#createRoom').click(function() {
										let request = {
											request: "create",
											permanent: false,
											description: "Afkor class",
											is_private: false,
											publishers: 10,
										};
								
										sfutest.send({
											message: request,
											success: function(response) {
												Janus.log("Room created:", response);
												myroom = response.room;
												console.log(myroom);
												alert("Room " + response.room + " успешно создана!");
											},
											error: function(error) {
												Janus.error("Error creating room:", error);
												alert("Ошибка создания комнаты: " + error.message);
											}
										});
									});
									// Prepare the username registration
									$('#videojoin').removeClass('hide').removeClass('hide');
									$('#registernow').removeClass('hide').removeClass('hide');
									$('#register').click(registerUsername);
									$('#username').focus();
									$('#start').removeAttr('disabled').html("Stop")
										.click(function() {
											$(this).attr('disabled', true);
											janus.destroy();
										});
								},
								error: function(error) {
									Janus.error("  -- Error attaching plugin...", error);
									bootbox.alert("Error attaching plugin... " + error);
								},
								consentDialog: function(on) {
									Janus.debug("Consent dialog should be " + (on ? "on" : "off") + " now");
									if(on) {
										// Darken screen and show hint
										$.blockUI({
											message: '<div><img src="up_arrow.png"/></div>',
											baseZ: 3001,
											css: {
												border: 'none',
												padding: '15px',
												backgroundColor: 'transparent',
												color: '#aaa',
												top: '10px',
												left: '100px'
											} });
									} else {
										// Restore screen
										$.unblockUI();
									}
								},
								iceState: function(state) {
									Janus.log("ICE state changed to " + state);
								},
								mediaState: function(medium, on, mid) {
									Janus.log("Janus " + (on ? "started" : "stopped") + " receiving our " + medium + " (mid=" + mid + ")");
								},
								webrtcState: function(on) {
									Janus.log("Janus says our WebRTC PeerConnection is " + (on ? "up" : "down") + " now");
									$("#videolocal").parent().parent().unblock();
									if(!on)
										return;
									$('#publish').remove();
									// This controls allows us to override the global room bitrate cap
									$('#bitrate').parent().parent().removeClass('hide').removeClass('hide');
									$('#bitrate a').click(function() {
										$('.dropdown-toggle').dropdown('hide');
										let id = $(this).attr("id");
										let bitrate = parseInt(id)*1000;
										if(bitrate === 0) {
											Janus.log("Not limiting bandwidth via REMB");
										} else {
											Janus.log("Capping bandwidth to " + bitrate + " via REMB");
										}
										$('#bitrateset').text($(this).text()).parent().removeClass('open');
										sfutest.send({ message: { request: "configure", bitrate: bitrate }});
										return false;
									});
								},
								slowLink: function(uplink, lost, mid) {
									Janus.warn("Janus reports problems " + (uplink ? "sending" : "receiving") +
										" packets on mid " + mid + " (" + lost + " lost packets)");
								},
								onmessage: function(msg, jsep) {
									Janus.debug(" ::: Got a message (publisher) :::", msg);
									let event = msg["videoroom"];
									Janus.debug("Event: " + event);
									if(event) {
										if(event === "joined") {
											// Publisher/manager created, negotiate WebRTC and attach to existing feeds, if any
											myid = msg["id"];
											mypvtid = msg["private_id"];
											Janus.log("Successfully joined room " + msg["room"] + " with ID " + myid);
											if(subscriber_mode) {
												$('#videojoin').addClass('hide');
												$('#videos').removeClass('hide').removeClass('hide');
											} else {
												publishOwnFeed(true);
											}
											// Any new feed to attach to?
											if(msg["publishers"]) {
												let list = msg["publishers"];
												Janus.debug("Got a list of available publishers/feeds:", list);
												for(let f in list) {
													if(list[f]["dummy"])
														continue;
													let id = list[f]["id"];
													let streams = list[f]["streams"];
													let display = list[f]["display"];
													for(let i in streams) {
														let stream = streams[i];
														stream["id"] = id;
														stream["display"] = display;
													}
													feedStreams[id] = streams;
													Janus.debug("  >> [" + id + "] " + display + ":", streams);
													newRemoteFeed(id, display, streams);
												}
											}
										} else if(event === "destroyed") {
											// The room has been destroyed
											Janus.warn("The room has been destroyed!");
											bootbox.alert("The room has been destroyed", function() {
												window.location.reload();
											});
										} else if(event === "event") {
											// Any info on our streams or a new feed to attach to?
											if(msg["streams"]) {
												let streams = msg["streams"];
												for(let i in streams) {
													let stream = streams[i];
													stream["id"] = myid;
													stream["display"] = myusername;
												}
												feedStreams[myid] = streams;
											} else if(msg["publishers"]) {
												let list = msg["publishers"];
												Janus.debug("Got a list of available publishers/feeds:", list);
												for(let f in list) {
													if(list[f]["dummy"])
														continue;
													let id = list[f]["id"];
													let display = list[f]["display"];
													let streams = list[f]["streams"];
													for(let i in streams) {
														let stream = streams[i];
														stream["id"] = id;
														stream["display"] = display;
													}
													feedStreams[id] = streams;
													Janus.debug("  >> [" + id + "] " + display + ":", streams);
													newRemoteFeed(id, display, streams);
												}
											} else if(msg["leaving"]) {
												// One of the publishers has gone away?
												let leaving = msg["leaving"];
												Janus.log("Publisher left: " + leaving);
												let remoteFeed = null;
												for(let i=1; i<6; i++) {
													if(feeds[i] && feeds[i].rfid == leaving) {
														remoteFeed = feeds[i];
														break;
													}
												}
												if(remoteFeed) {
													Janus.debug("Feed " + remoteFeed.rfid + " (" + remoteFeed.rfdisplay + ") has left the room, detaching");
													$('#remote'+remoteFeed.rfindex).empty().addClass('hide');
													$('#videoremote'+remoteFeed.rfindex).empty();
													feeds[remoteFeed.rfindex] = null;
													remoteFeed.detach();
												}
												delete feedStreams[leaving];
											} else if(msg["unpublished"]) {
												// One of the publishers has unpublished?
												let unpublished = msg["unpublished"];
												Janus.log("Publisher left: " + unpublished);
												if(unpublished === 'ok') {
													// That's us
													sfutest.hangup();
													return;
												}
												let remoteFeed = null;
												for(let i=1; i<6; i++) {
													if(feeds[i] && feeds[i].rfid == unpublished) {
														remoteFeed = feeds[i];
														break;
													}
												}
												if(remoteFeed) {
													Janus.debug("Feed " + remoteFeed.rfid + " (" + remoteFeed.rfdisplay + ") has left the room, detaching");
													$('#remote'+remoteFeed.rfindex).empty().addClass('hide');
													$('#videoremote'+remoteFeed.rfindex).empty();
													feeds[remoteFeed.rfindex] = null;
													remoteFeed.detach();
												}
												delete feedStreams[unpublished];
											} else if(msg["error"]) {
												if(msg["error_code"] === 426) {
													// This is a "no such room" error: give a more meaningful description
													bootbox.alert(
														"<p>Apparently room <code>" + myroom + "</code> (the one this demo uses as a test room) " +
														"does not exist...</p><p>Do you have an updated <code>janus.plugin.videoroom.jcfg</code> " +
														"configuration file? If not, make sure you copy the details of room <code>" + myroom + "</code> " +
														"from that sample in your current configuration file, then restart Janus and try again."
													);
												} else {
													bootbox.alert(msg["error"]);
												}
											}
										}
									}
									if(jsep) {
										Janus.debug("Handling SDP as well...", jsep);
										sfutest.handleRemoteJsep({ jsep: jsep });
										// Check if any of the media we wanted to publish has
										// been rejected (e.g., wrong or unsupported codec)
										let audio = msg["audio_codec"];
										if(mystream && mystream.getAudioTracks() && mystream.getAudioTracks().length > 0 && !audio) {
											// Audio has been rejected
											toastr.warning("Our audio stream has been rejected, viewers won't hear us");
										}
										let video = msg["video_codec"];
										if(mystream && mystream.getVideoTracks() && mystream.getVideoTracks().length > 0 && !video) {
											// Video has been rejected
											toastr.warning("Our video stream has been rejected, viewers won't see us");
											// Hide the webcam video
											$('#myvideo').addClass('hide');
											$('#videolocal').prepend(
												'<div class="no-video-container">' +
													'<i class="fa-solid fa-video fa-xl no-video-icon" style="height: 100%;"></i>' +
													'<span class="no-video-text" style="font-size: 16px;">Video rejected, no webcam</span>' +
												'</div>');
										}
									}
								},
								onlocaltrack: function(track, on) {
									Janus.debug("Local track " + (on ? "added" : "removed") + ":", track);
									// We use the track ID as name of the element, but it may contain invalid characters
									let trackId = track.id.replace(/[{}]/g, "");
									if(!on) {
										// Track removed, get rid of the stream and the rendering
										let stream = localTracks[trackId];
										if(stream) {
											try {
												let tracks = stream.getTracks();
												for(let i in tracks) {
													let mst = tracks[i];
													if(mst !== null && mst !== undefined)
														mst.stop();
												}
											// eslint-disable-next-line no-unused-vars
											} catch(e) {}
										}
										if(track.kind === "video") {
											$('#myvideo' + trackId).remove();
											localVideos--;
											if(localVideos === 0) {
												// No video, at least for now: show a placeholder
												if($('#videolocal .no-video-container').length === 0) {
													$('#videolocal').prepend(
														'<div class="no-video-container">' +
															'<i class="fa-solid fa-video fa-xl no-video-icon"></i>' +
															'<span class="no-video-text">No webcam available</span>' +
														'</div>');
												}
											}
										}
										delete localTracks[trackId];
										return;
									}
									// If we're here, a new track was added
									let stream = localTracks[trackId];
									if(stream) {
										// We've been here already
										return;
									}
									$('#videos').removeClass('hide').removeClass('hide');
									if($('#mute').length === 0) {
										// Add a 'mute' button
										$('#videolocal').append('<button class="btn btn-warning btn-sm bottom-left m-2" id="mute">Выключить аудио</button>');
										$('#mute').click(toggleMute);
										// Add an 'unpublish' button
										$('#videolocal').append('<button class="btn btn-warning btn-sm bottom-right m-2" id="mutevideo">Выключить видео</button>');
										$('#mutevideo').click(toggleVideo);
									}
									if(track.kind === "audio") {
										// We ignore local audio tracks, they'd generate echo anyway
										if(localVideos === 0) {
											// No video, at least for now: show a placeholder
											if($('#videolocal .no-video-container').length === 0) {
												$('#videolocal').prepend(
													'<div class="no-video-container">' +
														'<i class="fa-solid fa-video fa-xl no-video-icon"></i>' +
														'<span class="no-video-text">No webcam available</span>' +
													'</div>');
											}
										}
									} else {
										// New video track: create a stream out of it
										localVideos++;
										$('#videolocal .no-video-container').remove();
										stream = new MediaStream([track]);
										localTracks[trackId] = stream;
										Janus.log("Created local stream:", stream);
										Janus.log(stream.getTracks());
										Janus.log(stream.getVideoTracks());
										$('#videolocal').prepend('<video class="rounded centered" id="myvideo' + trackId + '" width=100% autoplay playsinline muted="muted"/>');
										Janus.attachMediaStream($('#myvideo' + trackId).get(0), stream);
									}
									if(sfutest.webrtcStuff.pc.iceConnectionState !== "completed" &&
											sfutest.webrtcStuff.pc.iceConnectionState !== "connected") {
										$("#videolocal").parent().parent().block({
											message: '<b>Подключение...</b>',
											css: {
												border: 'none',
												backgroundColor: 'transparent',
												color: 'white'
											}
										});
									}
								},
								// eslint-disable-next-line no-unused-vars
								onremotetrack: function(track, mid, on) {
									// The publisher stream is sendonly, we don't expect anything here
								},
								oncleanup: function() {
									Janus.log(" ::: Got a cleanup notification: we are unpublished now :::");
									mystream = null;
									delete feedStreams[myid];
									$('#videolocal').html('<button id="publish" class="btn btn-primary">Подключиться</button>');
									$('#publish').click(function() { publishOwnFeed(true); });
									$("#videolocal").parent().parent().unblock();
									$('#bitrate').parent().parent().addClass('hide');
									$('#bitrate a').unbind('click');
									localTracks = {};
									localVideos = 0;
								}
							});
					},
					error: function(error) {
						Janus.error(error);
						bootbox.alert(error, function() {
							window.location.reload();
						});
					},
					destroyed: function() {
						window.location.reload();
					}
				});
		});
	}});
});

// eslint-disable-next-line no-unused-vars
function checkEnter(field, event) {
	let theCode = event.keyCode ? event.keyCode : event.which ? event.which : event.charCode;
	if(theCode == 13) {
		registerUsername();
		return false;
	} else {
		return true;
	}
}

function registerUsername() {
	if($('#username').length === 0) {
		// Create fields to register
		$('#register').click(registerUsername);
		$('#username').focus();
	} else {
		// Try a registration
		$('#username').attr('disabled', true);
		$('#register').attr('disabled', true).unbind('click');
		let username = $('#username').val();
		if(username === "") {
			$('#you')
				.removeClass().addClass('badge bg-warning')
				.html("Insert your display name (e.g., pippo)");
			$('#username').removeAttr('disabled');
			$('#register').removeAttr('disabled').click(registerUsername);
			return;
		}
		if(/[^a-zA-Z0-9]/.test(username)) {
			$('#you')
				.removeClass().addClass('badge bg-warning')
				.html('Input is not alphanumeric');
			$('#username').removeAttr('disabled').val("");
			$('#register').removeAttr('disabled').click(registerUsername);
			return;
		}
		if(myroom === 0) {
			myroom = $('#roomIdInput').val();
		}
		console.log(myroom);
		let register = {
			request: "join",
			room: +myroom,
			ptype: "publisher",
			display: username
		};
		myusername = escapeXmlTags(username);
		sfutest.send({ message: register });
	}
}

function publishOwnFeed(useAudio) {
	// Publish our stream
	$('#publish').attr('disabled', true).unbind('click');

	// We want sendonly audio and video (uncomment the data track
	// too if you want to publish via datachannels as well)
	let tracks = [];
	if(useAudio)
		tracks.push({ type: 'audio', capture: true, recv: false });
	tracks.push({ type: 'video', capture: true, recv: false,
		// We may need to enable simulcast or SVC on the video track
		simulcast: doSimulcast,
		// We only support SVC for VP9 and (still WIP) AV1
		svc: ((vcodec === 'vp9' || vcodec === 'av1') && doSvc) ? doSvc : null
	});
	//~ tracks.push({ type: 'data' });

	sfutest.createOffer(
		{
			tracks: tracks,
			customizeSdp: function(jsep) {
				// If DTX is enabled, munge the SDP
				if(doDtx) {
					jsep.sdp = jsep.sdp
						.replace("useinbandfec=1", "useinbandfec=1;usedtx=1")
				}
			},
			success: function(jsep) {
				Janus.debug("Got publisher SDP!", jsep);
				let publish = { request: "configure", audio: useAudio, video: true };
				// You can force a specific codec to use when publishing by using the
				// audiocodec and videocodec properties, for instance:
				// 		publish["audiocodec"] = "opus"
				// to force Opus as the audio codec to use, or:
				// 		publish["videocodec"] = "vp9"
				// to force VP9 as the videocodec to use. In both case, though, forcing
				// a codec will only work if: (1) the codec is actually in the SDP (and
				// so the browser supports it), and (2) the codec is in the list of
				// allowed codecs in a room. With respect to the point (2) above,
				// refer to the text in janus.plugin.videoroom.jcfg for more details.
				// We allow people to specify a codec via query string, for demo purposes
				if(acodec)
					publish["audiocodec"] = acodec;
				if(vcodec)
					publish["videocodec"] = vcodec;
				sfutest.send({ message: publish, jsep: jsep });
			},
			error: function(error) {
				Janus.error("WebRTC error:", error);
				if(useAudio) {
					publishOwnFeed(false);
				} else {
					bootbox.alert("WebRTC error... " + error.message);
					$('#publish').removeAttr('disabled').click(function() { publishOwnFeed(true); });
				}
			}
		});
}

function toggleMute() {
	let muted = sfutest.isAudioMuted();
	Janus.log((muted ? "Unmuting" : "Muting") + " local stream...");
	if(muted)
		sfutest.unmuteAudio();
	else
		sfutest.muteAudio();
	muted = sfutest.isAudioMuted();
	$('#mute').html(muted ? "Включить аудио" : "Выключить аудио");
}

function toggleVideo() {
    let videoMuted = sfutest.isVideoMuted();
    Janus.log((videoMuted ? "Enabling" : "Disabling") + " local video...");
    if (videoMuted) {
        sfutest.unmuteVideo();
    } else {
        sfutest.muteVideo();
    }
    videoMuted = sfutest.isVideoMuted();
    $('#mutevideo').html(videoMuted ? "Включить видео" : "Выключить видео");
}

// eslint-disable-next-line no-unused-vars
function newRemoteFeed(id, display, streams) {
	// A new feed has been published, create a new plugin handle and attach to it as a subscriber
	let remoteFeed = null;
	if(!streams)
		streams = feedStreams[id];
	janus.attach(
		{
			plugin: "janus.plugin.videoroom",
			opaqueId: opaqueId,
			success: function(pluginHandle) {
				remoteFeed = pluginHandle;
				remoteFeed.remoteTracks = {};
				remoteFeed.remoteVideos = 0;
				remoteFeed.simulcastStarted = false;
				remoteFeed.svcStarted = false;
				Janus.log("Plugin attached! (" + remoteFeed.getPlugin() + ", id=" + remoteFeed.getId() + ")");
				Janus.log("  -- This is a subscriber");
				// Prepare the streams to subscribe to, as an array: we have the list of
				// streams the feed is publishing, so we can choose what to pick or skip
				let subscription = [];
				for(let i in streams) {
					let stream = streams[i];
					// If the publisher is VP8/VP9 and this is an older Safari, let's avoid video
					if(stream.type === "video" && Janus.webRTCAdapter.browserDetails.browser === "safari" &&
							((stream.codec === "vp9" && !Janus.safariVp9) || (stream.codec === "vp8" && !Janus.safariVp8))) {
						toastr.warning("Publisher is using " + stream.codec.toUpperCase +
							", but Safari doesn't support it: disabling video stream #" + stream.mindex);
						continue;
					}
					subscription.push({
						feed: stream.id,	// This is mandatory
						mid: stream.mid		// This is optional (all streams, if missing)
					});
					// FIXME Right now, this is always the same feed: in the future, it won't
					remoteFeed.rfid = stream.id;
					remoteFeed.rfdisplay = escapeXmlTags(stream.display);
				}
				// We wait for the plugin to send us an offer
				if(myroom === 0) {
					myroom = $('#roomIdInput').val();
				}
				let subscribe = {
					request: "join",
					room: +myroom,
					ptype: "subscriber",
					streams: subscription,
					use_msid: use_msid,
					private_id: mypvtid
				};
				remoteFeed.send({ message: subscribe });
			},
			error: function(error) {
				Janus.error("  -- Error attaching plugin...", error);
				bootbox.alert("Error attaching plugin... " + error);
			},
			iceState: function(state) {
				Janus.log("ICE state (feed #" + remoteFeed.rfindex + ") changed to " + state);
			},
			webrtcState: function(on) {
				Janus.log("Janus says this WebRTC PeerConnection (feed #" + remoteFeed.rfindex + ") is " + (on ? "up" : "down") + " now");
			},
			slowLink: function(uplink, lost, mid) {
				Janus.warn("Janus reports problems " + (uplink ? "sending" : "receiving") +
					" packets on mid " + mid + " (" + lost + " lost packets)");
			},
			onmessage: function(msg, jsep) {
				Janus.debug(" ::: Got a message (subscriber) :::", msg);
				let event = msg["videoroom"];
				Janus.debug("Event: " + event);
				if(msg["error"]) {
					bootbox.alert(msg["error"]);
				} else if(event) {
					if(event === "attached") {
						// Subscriber created and attached
						for(let i=1;i<6;i++) {
							if(!feeds[i]) {
								feeds[i] = remoteFeed;
								remoteFeed.rfindex = i;
								break;
							}
						}
						Janus.log("Successfully attached to feed in room " + msg["room"]);
						$('#remote'+remoteFeed.rfindex).removeClass('hide').html(remoteFeed.rfdisplay).removeClass('hide');
					} else if(event === "event") {
						// Check if we got a simulcast-related event from this publisher
						let substream = msg["substream"];
						let temporal = msg["temporal"];
						if((substream !== null && substream !== undefined) || (temporal !== null && temporal !== undefined)) {
							if(!remoteFeed.simulcastStarted) {
								remoteFeed.simulcastStarted = true;
								// Add some new buttons
								addSimulcastSvcButtons(remoteFeed.rfindex, true);
							}
							// We just received notice that there's been a switch, update the buttons
							updateSimulcastSvcButtons(remoteFeed.rfindex, substream, temporal);
						}
						// Or maybe SVC?
						let spatial = msg["spatial_layer"];
						temporal = msg["temporal_layer"];
						if((spatial !== null && spatial !== undefined) || (temporal !== null && temporal !== undefined)) {
							if(!remoteFeed.svcStarted) {
								remoteFeed.svcStarted = true;
								// Add some new buttons
								addSimulcastSvcButtons(remoteFeed.rfindex, true);
							}
							// We just received notice that there's been a switch, update the buttons
							updateSimulcastSvcButtons(remoteFeed.rfindex, spatial, temporal);
						}
					} else {
						// What has just happened?
					}
				}
				if(jsep) {
					Janus.debug("Handling SDP as well...", jsep);
					let stereo = (jsep.sdp.indexOf("stereo=1") !== -1);
					// Answer and attach
					remoteFeed.createAnswer(
						{
							jsep: jsep,
							// We only specify data channels here, as this way in
							// case they were offered we'll enable them. Since we
							// don't mention audio or video tracks, we autoaccept them
							// as recvonly (since we won't capture anything ourselves)
							tracks: [
								{ type: 'data' }
							],
							customizeSdp: function(jsep) {
								if(stereo && jsep.sdp.indexOf("stereo=1") == -1) {
									// Make sure that our offer contains stereo too
									jsep.sdp = jsep.sdp.replace("useinbandfec=1", "useinbandfec=1;stereo=1");
								}
							},
							success: function(jsep) {
								Janus.debug("Got SDP!", jsep);
								let body = { request: "start", room: myroom };
								remoteFeed.send({ message: body, jsep: jsep });
							},
							error: function(error) {
								Janus.error("WebRTC error:", error);
								bootbox.alert("WebRTC error... " + error.message);
							}
						});
				}
			},
			// eslint-disable-next-line no-unused-vars
			onlocaltrack: function(track, on) {
				// The subscriber stream is recvonly, we don't expect anything here
			},
			onremotetrack: function(track, mid, on, metadata) {
				Janus.debug(
					"Remote feed #" + remoteFeed.rfindex +
					", remote track (mid=" + mid + ") " +
					(on ? "added" : "removed") +
					(metadata? " (" + metadata.reason + ") ": "") + ":", track
				);
				if(!on) {
					// Track removed, get rid of the stream and the rendering
					$('#remotevideo'+remoteFeed.rfindex + '-' + mid).remove();
					if(track.kind === "video") {
						remoteFeed.remoteVideos--;
						if(remoteFeed.remoteVideos === 0) {
							// No video, at least for now: show a placeholder
							if($('#videoremote'+remoteFeed.rfindex + ' .no-video-container').length === 0) {
								$('#videoremote'+remoteFeed.rfindex).append(
									'<div class="no-video-container">' +
										'<i class="fa-solid fa-video fa-xl no-video-icon"></i>' +
										'<span class="no-video-text">No remote video available</span>' +
									'</div>');
							}
						}
					}
					delete remoteFeed.remoteTracks[mid];
					return;
				}
				// If we're here, a new track was added
				if($('#remotevideo' + remoteFeed.rfindex + '-' + mid).length > 0)
					return;
				if(track.kind === "audio") {
					// New audio track: create a stream out of it, and use a hidden <audio> element
					let stream = new MediaStream([track]);
					remoteFeed.remoteTracks[mid] = stream;
					Janus.log("Created remote audio stream:", stream);
					$('#videoremote'+remoteFeed.rfindex).append('<audio class="hide" id="remotevideo' + remoteFeed.rfindex + '-' + mid + '" autoplay playsinline/>');
					Janus.attachMediaStream($('#remotevideo' + remoteFeed.rfindex + '-' + mid).get(0), stream);
					if(remoteFeed.remoteVideos === 0) {
						// No video, at least for now: show a placeholder
						if($('#videoremote'+remoteFeed.rfindex + ' .no-video-container').length === 0) {
							$('#videoremote'+remoteFeed.rfindex).append(
								'<div class="no-video-container">' +
									'<i class="fa-solid fa-video fa-xl no-video-icon"></i>' +
									'<span class="no-video-text">No remote video available</span>' +
								'</div>');
						}
					}
				} else {
					// New video track: create a stream out of it
					remoteFeed.remoteVideos++;
					$('#videoremote'+remoteFeed.rfindex + ' .no-video-container').remove();
					let stream = new MediaStream([track]);
					remoteFeed.remoteTracks[mid] = stream;
					Janus.log("Created remote video stream:", stream);
					$('#videoremote'+remoteFeed.rfindex).append('<video class="rounded centered" id="remotevideo' + remoteFeed.rfindex + '-' + mid + '" width=100% autoplay playsinline/>');
					$('#videoremote'+remoteFeed.rfindex).append(
						'<span class="badge bg-primary bottom-left m-3 hide" id="curres'+remoteFeed.rfindex+'"></span>' +
						'<span class="badge bg-info bottom-right m-3 hide" id="curbitrate'+remoteFeed.rfindex+'"></span>');
					Janus.attachMediaStream($('#remotevideo' + remoteFeed.rfindex + '-' + mid).get(0), stream);
					// Note: we'll need this for additional videos too
					if(!bitrateTimer[remoteFeed.rfindex]) {
						$('#curbitrate'+remoteFeed.rfindex).removeClass('hide').removeClass('hide');
						bitrateTimer[remoteFeed.rfindex] = setInterval(function() {
							if(!$("#videoremote" + remoteFeed.rfindex + ' video').get(0))
								return;
							// Display updated bitrate, if supported
							let bitrate = remoteFeed.getBitrate();
							$('#curbitrate'+remoteFeed.rfindex).text(bitrate);
							// Check if the resolution changed too
							let width = $("#videoremote" + remoteFeed.rfindex + ' video').get(0).videoWidth;
							let height = $("#videoremote" + remoteFeed.rfindex + ' video').get(0).videoHeight;
							if(width > 0 && height > 0) {
								let res = width + 'x' + height;
								if(remoteFeed.simulcastStarted)
									res += ' (simulcast)';
								else if(remoteFeed.svcStarted)
									res += ' (SVC)';
								$('#curres'+remoteFeed.rfindex).removeClass('hide').text(res).removeClass('hide');
							}
						}, 1000);
					}
				}
			},
			oncleanup: function() {
				Janus.log(" ::: Got a cleanup notification (remote feed " + id + ") :::");
				$('#remotevideo'+remoteFeed.rfindex).remove();
				$('#waitingvideo'+remoteFeed.rfindex).remove();
				$('#novideo'+remoteFeed.rfindex).remove();
				$('#curbitrate'+remoteFeed.rfindex).remove();
				$('#curres'+remoteFeed.rfindex).remove();
				if(bitrateTimer[remoteFeed.rfindex])
					clearInterval(bitrateTimer[remoteFeed.rfindex]);
				bitrateTimer[remoteFeed.rfindex] = null;
				remoteFeed.simulcastStarted = false;
				$('#simulcast'+remoteFeed.rfindex).remove();
				remoteFeed.remoteTracks = {};
				remoteFeed.remoteVideos = 0;
			}
		});
}

// Helper to parse query string
function getQueryStringValue(name) {
	name = name.replace(/[[]/, "\\[").replace(/[\]]/, "\\]");
	let regex = new RegExp("[\\?&]" + name + "=([^&#]*)"),
		results = regex.exec(location.search);
	return results === null ? "" : decodeURIComponent(results[1].replace(/\+/g, " "));
}

// Helper to escape XML tags
function escapeXmlTags(value) {
	if(value) {
		let escapedValue = value.replace(new RegExp('<', 'g'), '&lt');
		escapedValue = escapedValue.replace(new RegExp('>', 'g'), '&gt');
		return escapedValue;
	}
}

// Helpers to create Simulcast- or SVC-related UI, if enabled
function addSimulcastSvcButtons(feed, temporal) {
	let index = feed;
	let f = feeds[index];
	let simulcast = (f && f.simulcastStarted);
	let what = (simulcast ? 'simulcast' : 'SVC');
	let layer = (simulcast ? 'substream' : 'layer');
	$('#remote'+index).parent().append(
		'<div id="simulcast'+index+'" class="btn-group-vertical btn-group-xs top-right">' +
		'	<div class="btn-group btn-group-xs d-flex" style="width: 100%">' +
		'		<button id="sl'+index+'-2" type="button" class="btn btn-primary" data-bs-toggle="tooltip" title="Switch to higher quality">SL 2</button>' +
		'		<button id="sl'+index+'-1" type="button" class="btn btn-primary" data-bs-toggle="tooltip" title="Switch to normal quality">SL 1</button>' +
		'		<button id="sl'+index+'-0" type="button" class="btn btn-primary" data-bs-toggle="tooltip" title="Switch to lower quality">SL 0</button>' +
		'	</div>' +
		'	<div class="btn-group btn-group-xs d-flex hide" style="width: 100%">' +
		'		<button id="tl'+index+'-2" type="button" class="btn btn-primary" data-bs-toggle="tooltip" title="Cap to temporal layer 2">TL 2</button>' +
		'		<button id="tl'+index+'-1" type="button" class="btn btn-primary" data-bs-toggle="tooltip" title="Cap to temporal layer 1">TL 1</button>' +
		'		<button id="tl'+index+'-0" type="button" class="btn btn-primary" data-bs-toggle="tooltip" title="Cap to temporal layer 0">TL 0</button>' +
		'	</div>' +
		'</div>'
	);
	if(simulcast && Janus.webRTCAdapter.browserDetails.browser !== "firefox") {
		// Chromium-based browsers only have two temporal layers, when doing simulcast
		$('#tl'+index+'-2').remove();
	}
	// Enable the simulcast/SVC selection buttons
	$('#sl' + index + '-0').removeClass('btn-primary btn-success').addClass('btn-primary')
		.unbind('click').click(function() {
			toastr.info("Switching " + what + " " + layer + ", wait for it... (lower quality)", null, {timeOut: 2000});
			if(!$('#sl' + index + '-2').hasClass('btn-success'))
				$('#sl' + index + '-2').removeClass('btn-primary btn-info').addClass('btn-primary');
			if(!$('#sl' + index + '-1').hasClass('btn-success'))
				$('#sl' + index + '-1').removeClass('btn-primary btn-info').addClass('btn-primary');
			$('#sl' + index + '-0').removeClass('btn-primary btn-info btn-success').addClass('btn-info');
			let f = feeds[index];
			if(f.simulcastStarted)
				f.send({ message: { request: "configure", substream: 0 }});
			else
				f.send({ message: { request: "configure", spatial_layer: 0 }});
		});
	$('#sl' + index + '-1').removeClass('btn-primary btn-success').addClass('btn-primary')
		.unbind('click').click(function() {
			toastr.info("Switching " + what + " " + layer + ", wait for it... (normal quality)", null, {timeOut: 2000});
			if(!$('#sl' + index + '-2').hasClass('btn-success'))
				$('#sl' + index + '-2').removeClass('btn-primary btn-info').addClass('btn-primary');
			$('#sl' + index + '-1').removeClass('btn-primary btn-info btn-success').addClass('btn-info');
			if(!$('#sl' + index + '-0').hasClass('btn-success'))
				$('#sl' + index + '-0').removeClass('btn-primary btn-info').addClass('btn-primary');
			let f = feeds[index];
			if(f.simulcastStarted)
				f.send({ message: { request: "configure", substream: 1 }});
			else
				f.send({ message: { request: "configure", spatial_layer: 1 }});
		});
	$('#sl' + index + '-2').removeClass('btn-primary btn-success').addClass('btn-primary')
		.unbind('click').click(function() {
			toastr.info("Switching " + what + " " + layer + ", wait for it... (higher quality)", null, {timeOut: 2000});
			$('#sl' + index + '-2').removeClass('btn-primary btn-info btn-success').addClass('btn-info');
			if(!$('#sl' + index + '-1').hasClass('btn-success'))
				$('#sl' + index + '-1').removeClass('btn-primary btn-info').addClass('btn-primary');
			if(!$('#sl' + index + '-0').hasClass('btn-success'))
				$('#sl' + index + '-0').removeClass('btn-primary btn-info').addClass('btn-primary');
			let f = feeds[index];
			if(f.simulcastStarted)
				f.send({ message: { request: "configure", substream: 2 }});
			else
				f.send({ message: { request: "configure", spatial_layer: 2 }});
		});
	if(!temporal)	// No temporal layer support
		return;
	$('#tl' + index + '-0').parent().removeClass('hide');
	$('#tl' + index + '-0').removeClass('btn-primary btn-success').addClass('btn-primary')
		.unbind('click').click(function() {
			toastr.info("Capping " + what + " temporal layer, wait for it... (lowest FPS)", null, {timeOut: 2000});
			if(!$('#tl' + index + '-2').hasClass('btn-success'))
				$('#tl' + index + '-2').removeClass('btn-primary btn-info').addClass('btn-primary');
			if(!$('#tl' + index + '-1').hasClass('btn-success'))
				$('#tl' + index + '-1').removeClass('btn-primary btn-info').addClass('btn-primary');
			$('#tl' + index + '-0').removeClass('btn-primary btn-info btn-success').addClass('btn-info');
			let f = feeds[index];
			if(f.simulcastStarted)
				f.send({ message: { request: "configure", temporal: 0 }});
			else
				f.send({ message: { request: "configure", temporal_layer: 0 }});
		});
	$('#tl' + index + '-1').removeClass('btn-primary btn-success').addClass('btn-primary')
		.unbind('click').click(function() {
			toastr.info("Capping " + what + " temporal layer, wait for it... (medium FPS)", null, {timeOut: 2000});
			if(!$('#tl' + index + '-2').hasClass('btn-success'))
				$('#tl' + index + '-2').removeClass('btn-primary btn-info').addClass('btn-primary');
			$('#tl' + index + '-1').removeClass('btn-primary btn-info').addClass('btn-info');
			if(!$('#tl' + index + '-0').hasClass('btn-success'))
				$('#tl' + index + '-0').removeClass('btn-primary btn-info').addClass('btn-primary');
			let f = feeds[index];
			if(f.simulcastStarted)
				f.send({ message: { request: "configure", temporal: 1 }});
			else
				f.send({ message: { request: "configure", temporal_layer: 1 }});
		});
	$('#tl' + index + '-2').removeClass('btn-primary btn-success').addClass('btn-primary')
		.unbind('click').click(function() {
			toastr.info("Capping " + what + " temporal layer, wait for it... (highest FPS)", null, {timeOut: 2000});
			$('#tl' + index + '-2').removeClass('btn-primary btn-info btn-success').addClass('btn-info');
			if(!$('#tl' + index + '-1').hasClass('btn-success'))
				$('#tl' + index + '-1').removeClass('btn-primary btn-info').addClass('btn-primary');
			if(!$('#tl' + index + '-0').hasClass('btn-success'))
				$('#tl' + index + '-0').removeClass('btn-primary btn-info').addClass('btn-primary');
			let f = feeds[index];
			if(f.simulcastStarted)
				f.send({ message: { request: "configure", temporal: 2 }});
			else
				f.send({ message: { request: "configure", temporal_layer: 2 }});
		});
}

function updateSimulcastSvcButtons(feed, substream, temporal) {
	// Check the substream
	let index = feed;
	let f = feeds[index];
	let simulcast = (f && f.simulcastStarted);
	let what = (simulcast ? 'simulcast' : 'SVC');
	let layer = (simulcast ? 'substream' : 'layer');
	if(substream === 0) {
		toastr.success("Switched " + what + " " + layer + "! (lower quality)", null, {timeOut: 2000});
		$('#sl' + index + '-2').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#sl' + index + '-1').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#sl' + index + '-0').removeClass('btn-primary btn-info btn-success').addClass('btn-success');
	} else if(substream === 1) {
		toastr.success("Switched " + what + " " + layer + "! (normal quality)", null, {timeOut: 2000});
		$('#sl' + index + '-2').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#sl' + index + '-1').removeClass('btn-primary btn-info btn-success').addClass('btn-success');
		$('#sl' + index + '-0').removeClass('btn-primary btn-success').addClass('btn-primary');
	} else if(substream === 2) {
		toastr.success("Switched " + what + " " + layer + "! (higher quality)", null, {timeOut: 2000});
		$('#sl' + index + '-2').removeClass('btn-primary btn-info btn-success').addClass('btn-success');
		$('#sl' + index + '-1').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#sl' + index + '-0').removeClass('btn-primary btn-success').addClass('btn-primary');
	}
	// Check the temporal layer
	if(temporal === 0) {
		toastr.success("Capped " + what + " temporal layer! (lowest FPS)", null, {timeOut: 2000});
		$('#tl' + index + '-2').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#tl' + index + '-1').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#tl' + index + '-0').removeClass('btn-primary btn-info btn-success').addClass('btn-success');
	} else if(temporal === 1) {
		toastr.success("Capped " + what + " temporal layer! (medium FPS)", null, {timeOut: 2000});
		$('#tl' + index + '-2').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#tl' + index + '-1').removeClass('btn-primary btn-info btn-success').addClass('btn-success');
		$('#tl' + index + '-0').removeClass('btn-primary btn-success').addClass('btn-primary');
	} else if(temporal === 2) {
		toastr.success("Capped " + what + " temporal layer! (highest FPS)", null, {timeOut: 2000});
		$('#tl' + index + '-2').removeClass('btn-primary btn-info btn-success').addClass('btn-success');
		$('#tl' + index + '-1').removeClass('btn-primary btn-success').addClass('btn-primary');
		$('#tl' + index + '-0').removeClass('btn-primary btn-success').addClass('btn-primary');
	}
}
