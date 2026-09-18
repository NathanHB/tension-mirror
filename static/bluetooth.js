/**
 * Based heavily on the excellent blogpost from Philipp Bazun:
 *
 * https://web.archive.org/web/20240203155713/https://www.bazun.me/blog/kiterboard/#reversing-bluetooth
 *
 */

const MAX_BLUETOOTH_MESSAGE_SIZE = 20;
const MESSAGE_BODY_MAX_LENGTH = 255;
const PACKET_MIDDLE = 81;
const PACKET_FIRST = 82;
const PACKET_LAST = 83;
const PACKET_ONLY = 84;
const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const CHARACTERISTIC_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const BLUETOOTH_UNDEFINED = "navigator.bluetooth is undefined";
const BLUETOOTH_CANCELLED = "User cancelled the requestDevice() chooser.";

let bluetoothDevice = null;

function checksum(data) {
  let i = 0;
  for (const value of data) {
    i = (i + value) & 255;
  }
  return ~i & 255;
}

function wrapBytes(data) {
  if (data.length > MESSAGE_BODY_MAX_LENGTH) {
    return [];
  }

  return [1, data.length, checksum(data), 2, ...data, 3];
}

function encodePosition(position) {
  const position1 = position & 255;
  const position2 = (position & 65280) >> 8;
  return [position1, position2];
}

function encodeColor(color) {
  const substring = color.substring(0, 2);
  const substring2 = color.substring(2, 4);

  const parsedSubstring = parseInt(substring, 16) / 32;
  const parsedSubstring2 = parseInt(substring2, 16) / 32;
  const parsedResult = (parsedSubstring << 5) | (parsedSubstring2 << 2);

  const substring3 = color.substring(4, 6);
  const parsedSubstring3 = parseInt(substring3, 16) / 64;
  const finalParsedResult = parsedResult | parsedSubstring3;

  return finalParsedResult;
}

function encodePositionAndColor(position, ledColor) {
  return [...encodePosition(position), encodeColor(ledColor)];
}

function getBluetoothPacket(frames, placementPositions, colors) {
  const resultArray = [];
  let tempArray = [PACKET_MIDDLE];
  frames.split("p").forEach((frame) => {
    if (frame.length > 0) {
      const [placement, role] = frame.split("r");
      const encodedFrame = encodePositionAndColor(
        Number(placementPositions[placement]),
        colors[role]
      );
      if (tempArray.length + 3 > MESSAGE_BODY_MAX_LENGTH) {
        resultArray.push(tempArray);
        tempArray = [PACKET_MIDDLE];
      }
      tempArray.push(...encodedFrame);
    }
  });

  resultArray.push(tempArray);

  if (resultArray.length === 1) {
    resultArray[0][0] = PACKET_ONLY;
  } else if (resultArray.length > 1) {
    resultArray[0][0] = PACKET_FIRST;
    resultArray[resultArray.length - 1][0] = PACKET_LAST;
  }

  const finalResultArray = [];
  for (const currentArray of resultArray) {
    finalResultArray.push(...wrapBytes(currentArray));
  }

  return Uint8Array.from(finalResultArray);
}

function splitEvery(n, list) {
  if (n <= 0) {
    throw new Error("First argument to splitEvery must be a positive integer");
  }
  var result = [];
  var idx = 0;
  while (idx < list.length) {
    result.push(list.slice(idx, (idx += n)));
  }
  return result;
}

function hasNativeBluetoothBridge() {
  return Boolean(window.webkit?.messageHandlers?.bluetooth);
}

// Two things can light up the board: the climb viewer's single button, and
// the +1 game (one write per click, silently). Each has its own optional
// status/button elements to update; this is how both share the same
// underlying connect/write code without stepping on each other's UI.
const BLUETOOTH_UI_CONTEXTS = {
  climb: { button: "illuminate-button", status: "illuminate-error" },
  plusone: { button: null, status: "plusone-bluetooth-status" },
};

function bluetoothUi(context) {
  return BLUETOOTH_UI_CONTEXTS[context] || BLUETOOTH_UI_CONTEXTS.climb;
}

// Called by the native Swift/CoreBluetooth bridge (Mac app build only), and
// by the in-browser Web Bluetooth path below, once a light-up attempt
// finishes either way. Centralizing this is what lets both paths share the
// same "Looking for board..." -> done/error UI reset.
// Called by the Swift bridge with progress text ("Looking for board...",
// "Connecting...") before the final result comes in via nativeBluetoothResult.
window.nativeBluetoothStatus = function (text, context) {
  const statusEl = bluetoothUi(context).status;
  const el = statusEl && document.getElementById(statusEl);
  if (el) el.textContent = text;
};

window.nativeBluetoothResult = function (ok, message, context) {
  const ui = bluetoothUi(context);
  const statusEl = ui.status && document.getElementById(ui.status);
  const button = ui.button && document.getElementById(ui.button);
  if (button) button.disabled = false;
  if (statusEl) {
    statusEl.textContent = ok ? "" : message || "Failed to connect to LEDs.";
  }
  if (ok) {
    console.log("Climb illuminated");
  } else if (message && context !== "plusone") {
    // The +1 game fires on every click - an alert per click would be
    // unusable, so it only gets the inline status text, no popup.
    alert(message);
  }
};

function illuminateClimbViaNativeBridge(board, bluetoothPacket, context) {
  const capitalizedBoard = board[0].toUpperCase() + board.slice(1);
  const chunks = splitEvery(MAX_BLUETOOTH_MESSAGE_SIZE, bluetoothPacket).map((chunk) =>
    Array.from(chunk)
  );
  window.webkit.messageHandlers.bluetooth.postMessage({
    board: capitalizedBoard,
    chunks,
    context,
  });
}

function illuminateClimb(board, bluetoothPacket, context = "climb") {
  const ui = bluetoothUi(context);
  const button = ui.button && document.getElementById(ui.button);
  const statusEl = ui.status && document.getElementById(ui.status);
  if (button) button.disabled = true;
  if (statusEl) statusEl.textContent = "Looking for board…";

  if (hasNativeBluetoothBridge()) {
    illuminateClimbViaNativeBridge(board, bluetoothPacket, context);
    return;
  }

  const capitalizedBoard = board[0].toUpperCase() + board.slice(1);
  requestDevice(capitalizedBoard)
    .then((device) => {
      return device.gatt.connect();
    })
    .then((server) => {
      return server.getPrimaryService(SERVICE_UUID);
    })
    .then((service) => {
      return service.getCharacteristic(CHARACTERISTIC_UUID);
    })
    .then((characteristic) => {
      const splitMessages = (buffer) =>
        splitEvery(MAX_BLUETOOTH_MESSAGE_SIZE, buffer).map(
          (arr) => new Uint8Array(arr)
        );
      return writeCharacteristicSeries(
        characteristic,
        splitMessages(bluetoothPacket)
      );
    })
    .then(() => window.nativeBluetoothResult(true, null, context))
    .catch((error) => {
      if (error.message === BLUETOOTH_CANCELLED) {
        window.nativeBluetoothResult(true, null, context); // silent - user just closed the picker
        return;
      }
      const message =
        error.message === BLUETOOTH_UNDEFINED
          ? "Web Bluetooth is not supported on this browser. See https://caniuse.com/web-bluetooth for more information."
          : `Failed to connect to LEDS: ${error}`;
      window.nativeBluetoothResult(false, message, context);
    });
}

async function writeCharacteristicSeries(characteristic, messages) {
  let returnValue = null;
  for (const message of messages) {
    returnValue = await characteristic.writeValue(message);
  }
  return returnValue;
}

async function requestDevice(namePrefix) {
  if (!bluetoothDevice) {
    bluetoothDevice = await navigator.bluetooth.requestDevice({
      filters: [
        {
          namePrefix,
        },
      ],
      optionalServices: [SERVICE_UUID],
    });
  }
  return bluetoothDevice;
}
