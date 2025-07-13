import "./style.css";

import firebase from "firebase/app";
import "firebase/firestore";

const firebaseConfig = {};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const firestore = firebase.firestore();

const servers = {
  iceServers: [
    {
      urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"],
    },
  ],
  iceCandidatePoolSize: 10,
};

// Global State
const pc = new RTCPeerConnection(servers);
let localStream = null;
let remoteStream = null;
let isCameraOn = false;
let isMicOn = false;

// HTML elements
const webcamButton = document.getElementById("webcamButton");
const webcamVideo = document.getElementById("webcamVideo");
const callButton = document.getElementById("callButton");
const callInput = document.getElementById("callInput");
const answerButton = document.getElementById("answerButton");
const remoteVideo = document.getElementById("remoteVideo");
const hangupButton = document.getElementById("hangupButton");
const toggleCameraButton = document.getElementById("toggleCameraButton");
const toggleMicButton = document.getElementById("toggleMicButton");

// Function to create a placeholder video track (black screen with text)
function createPlaceholderVideoTrack() {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext("2d");

  // Create a black background with "Camera Off" text
  function drawPlaceholder() {
    ctx.fillStyle = "#2c3e50";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Add "Camera Off" text
    ctx.fillStyle = "#ecf0f1";
    ctx.font = "48px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Camera Off", canvas.width / 2, canvas.height / 2);

    // Add camera icon (simple representation)
    ctx.strokeStyle = "#ecf0f1";
    ctx.lineWidth = 4;
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2 - 80;

    // Camera body
    ctx.strokeRect(centerX - 40, centerY - 20, 80, 40);
    // Camera lens
    ctx.beginPath();
    ctx.arc(centerX, centerY, 15, 0, 2 * Math.PI);
    ctx.stroke();
    // Diagonal line through lens (indicating "off")
    ctx.beginPath();
    ctx.moveTo(centerX - 15, centerY - 15);
    ctx.lineTo(centerX + 15, centerY + 15);
    ctx.stroke();
  }

  drawPlaceholder();

  // Create video stream from canvas
  const stream = canvas.captureStream(1); // 1 FPS is enough for static placeholder
  return stream.getVideoTracks()[0];
}

// 1. Setup media sources

webcamButton.onclick = async () => {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  remoteStream = new MediaStream();

  // Push tracks from local stream to peer connection
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  // Pull tracks from remote stream, add to video stream
  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => {
      remoteStream.addTrack(track);
    });
  };

  webcamVideo.srcObject = localStream;
  remoteVideo.srcObject = remoteStream;

  callButton.disabled = false;
  answerButton.disabled = false;
  webcamButton.disabled = true;
  toggleCameraButton.disabled = false;
  toggleCameraButton.textContent = "Turn Camera Off";
  toggleMicButton.disabled = false;
  toggleMicButton.textContent = "Turn Mic Off";
  isCameraOn = true;
  isMicOn = true;
};

// 2. Create an offer
callButton.onclick = async () => {
  // Reference Firestore collections for signaling
  const callDoc = firestore.collection("calls").doc();
  const offerCandidates = callDoc.collection("offerCandidates");
  const answerCandidates = callDoc.collection("answerCandidates");

  callInput.value = callDoc.id;

  // Get candidates for caller, save to db
  pc.onicecandidate = (event) => {
    event.candidate && offerCandidates.add(event.candidate.toJSON());
  };

  // Create offer
  const offerDescription = await pc.createOffer();
  await pc.setLocalDescription(offerDescription);

  const offer = {
    sdp: offerDescription.sdp,
    type: offerDescription.type,
  };

  await callDoc.set({ offer });

  // Listen for remote answer
  callDoc.onSnapshot((snapshot) => {
    const data = snapshot.data();
    if (!pc.currentRemoteDescription && data?.answer) {
      const answerDescription = new RTCSessionDescription(data.answer);
      pc.setRemoteDescription(answerDescription);
    }
  });

  // When answered, add candidate to peer connection
  answerCandidates.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        const candidate = new RTCIceCandidate(change.doc.data());
        pc.addIceCandidate(candidate);
      }
    });
  });

  hangupButton.disabled = false;
};

// 3. Answer the call with the unique ID
answerButton.onclick = async () => {
  const callId = callInput.value;
  const callDoc = firestore.collection("calls").doc(callId);
  const answerCandidates = callDoc.collection("answerCandidates");
  const offerCandidates = callDoc.collection("offerCandidates");

  pc.onicecandidate = (event) => {
    event.candidate && answerCandidates.add(event.candidate.toJSON());
  };

  const callData = (await callDoc.get()).data();

  const offerDescription = callData.offer;
  await pc.setRemoteDescription(new RTCSessionDescription(offerDescription));

  const answerDescription = await pc.createAnswer();
  await pc.setLocalDescription(answerDescription);

  const answer = {
    type: answerDescription.type,
    sdp: answerDescription.sdp,
  };

  await callDoc.update({ answer });

  offerCandidates.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      console.log(change);
      if (change.type === "added") {
        let data = change.doc.data();
        pc.addIceCandidate(new RTCIceCandidate(data));
      }
    });
  });
};

// Toggle Camera functionality
toggleCameraButton.onclick = async () => {
  if (localStream) {
    if (isCameraOn) {
      // Turn off camera - stop the video track completely
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.stop(); // This actually stops the camera hardware
        localStream.removeTrack(videoTrack);

        // Remove the video track from the peer connection
        const sender = pc.getSenders().find((s) => s.track === videoTrack);
        if (sender) {
          // Replace with placeholder video instead of removing completely
          const placeholderTrack = createPlaceholderVideoTrack();
          localStream.addTrack(placeholderTrack);
          await sender.replaceTrack(placeholderTrack);
        }

        // Update the local video display to show no video
        webcamVideo.srcObject = localStream;
      }
      toggleCameraButton.textContent = "Turn Camera On";
      isCameraOn = false;
    } else {
      // Turn on camera - get new video stream
      try {
        const newVideoStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const newVideoTrack = newVideoStream.getVideoTracks()[0];

        // Remove placeholder track first
        const placeholderTrack = localStream.getVideoTracks()[0];
        if (placeholderTrack) {
          placeholderTrack.stop();
          localStream.removeTrack(placeholderTrack);
        }

        // Add the new video track to the local stream
        localStream.addTrack(newVideoTrack);

        // Replace the placeholder track in the peer connection with real video
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
        if (sender) {
          await sender.replaceTrack(newVideoTrack);
        } else {
          // If no video sender exists, add one
          pc.addTrack(newVideoTrack, localStream);
        }

        // Update the local video display
        webcamVideo.srcObject = localStream;

        toggleCameraButton.textContent = "Turn Camera Off";
        isCameraOn = true;
      } catch (error) {
        console.error("Error turning camera back on:", error);
        alert("Could not turn camera back on. Please check camera permissions.");
      }
    }
  }
};

// Toggle Microphone functionality
toggleMicButton.onclick = async () => {
  if (localStream) {
    if (isMicOn) {
      // Turn off microphone - stop the audio track completely
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.stop(); // This actually stops the microphone hardware
        localStream.removeTrack(audioTrack);

        // Remove the audio track from the peer connection
        const sender = pc.getSenders().find((s) => s.track === audioTrack);
        if (sender) {
          pc.removeTrack(sender);
        }
      }
      toggleMicButton.textContent = "Turn Mic On";
      isMicOn = false;
    } else {
      // Turn on microphone - get new audio stream
      try {
        const newAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const newAudioTrack = newAudioStream.getAudioTracks()[0];

        // Add the new audio track to the local stream
        localStream.addTrack(newAudioTrack);

        // Add the new audio track to the peer connection
        pc.addTrack(newAudioTrack, localStream);

        toggleMicButton.textContent = "Turn Mic Off";
        isMicOn = true;
      } catch (error) {
        console.error("Error turning microphone back on:", error);
        alert("Could not turn microphone back on. Please check microphone permissions.");
      }
    }
  }
};
