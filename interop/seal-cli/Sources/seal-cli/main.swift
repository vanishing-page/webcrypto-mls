import Foundation
import Crypto
@testable import RAAE

// Error type for input validation
enum CLIError:Error,CustomStringConvertible {
	case invalidHex(String)
	case invalidNonceMode(Int)
	case outOfRangeValue(String,String)

	var description:String {
		switch self {
		case .invalidHex(let hex):
			return "invalid hex value: \(hex)"
		case .invalidNonceMode(let mode):
			return "invalid nonce mode: \(mode)"
		case .outOfRangeValue(let field,let value):
			return "\(field) out of range: \(value)"
		}
	}
}

// Hex encoding/decoding helpers
enum Hex {
	static func decode(_ string:String)throws->[UInt8] {
		guard string.count%2==0 else {
			throw CLIError.invalidHex(string)
		}
		var out=[UInt8]()
		out.reserveCapacity(string.count/2)
		var index=string.startIndex
		while index<string.endIndex {
			let next=string.index(index,offsetBy:2)
			let hexPair=String(string[index..<next])
			guard let byte=UInt8(hexPair,radix:16) else {
				throw CLIError.invalidHex(hexPair)
			}
			out.append(byte)
			index=next
		}
		return out
	}

	static func encode(_ bytes:[UInt8])->String {
		bytes.map{String(format:"%02x",$0)}.joined()
	}
}

// Helper to extract key bytes for testing
func keyBytes(_ key:SymmetricKey)->[UInt8] {
	key.withUnsafeBytes{Array($0)}
}

// Numeric conversion helpers with range checking
func toUInt8(_ value:Int)throws->UInt8 {
	guard value>=0,value<=UInt8.max else {
		throw CLIError.outOfRangeValue("UInt8","\(value)")
	}
	return UInt8(value)
}

func toUInt16(_ value:Int)throws->UInt16 {
	guard value>=0,value<=UInt16.max else {
		throw CLIError.outOfRangeValue("UInt16","\(value)")
	}
	return UInt16(value)
}

func toUInt32(_ value:Int)throws->UInt32 {
	guard value>=0,value<=UInt32.max else {
		throw CLIError.outOfRangeValue("UInt32","\(value)")
	}
	return UInt32(value)
}

func toUInt64(_ value:Int)throws->UInt64 {
	guard value>=0 else {
		throw CLIError.outOfRangeValue("UInt64","\(value)")
	}
	return UInt64(value)
}

// Request types
struct ScheduleRequest:Decodable {
	let op:String
	let protocol_id:String
	let cek_hex:String
	let g_hex:String
	let payload_info:PayloadInfoData

	struct PayloadInfoData:Decodable {
		let aead_id:Int
		let segment_max:Int
		let kdf_id:Int
		let snap_id:Int
		let nonce_mode:Int
		let epoch_length:Int
		let salt_hex:String
	}
}

struct SealSegmentRequest:Decodable {
	let op:String
	let protocol_id:String
	let cek_hex:String
	let g_hex:String
	let payload_info:ScheduleRequest.PayloadInfoData
	let index:Int
	let is_final:Int
	let plaintext_hex:String
	let nonce_hex:String?
}

struct OpenSegmentRequest:Decodable {
	let op:String
	let protocol_id:String
	let cek_hex:String
	let g_hex:String
	let payload_info:ScheduleRequest.PayloadInfoData
	let index:Int
	let is_final:Int
	let ct_hex:String
	let tag_hex:String
	let nonce_hex:String
}

// Parse JSON from stdin
func readRequest()->[String:Any]? {
	guard let jsonData=FileHandle.standardInput.readDataToEndOfFile() as Data?,
		  !jsonData.isEmpty else {
		return nil
	}
	return try?JSONSerialization.jsonObject(with:jsonData) as?[String:Any]
}

// Send response to stdout
func sendResponse(_ response:[String:Any]) {
	do {
		let data=try JSONSerialization.data(withJSONObject:response)
		FileHandle.standardOutput.write(data)
	} catch {
		let fallback="[{\"error\":\"failed to encode response\"}]"
		FileHandle.standardOutput.write(fallback.data(using:.utf8)!)
	}
}

func sendError(_ message:String) {
	sendResponse(["error":message])
}

func main() {
	guard let request=readRequest() else {
		sendError("failed to read stdin")
		exit(1)
	}

	guard let op=request["op"]as?String else {
		sendError("missing op field")
		exit(1)
	}

	do {
		switch op {
		case "schedule":
			try handleSchedule(request:request)
		case "seal_segment":
			try handleSealSegment(request:request)
		case "open_segment":
			try handleOpenSegment(request:request)
		default:
			sendError("unknown op: \(op)")
			exit(1)
		}
	} catch {
		sendError("error: \(error)")
		exit(1)
	}
}

func handleSchedule(request:[String:Any])throws {
	guard let protocolIdStr=request["protocol_id"]as?String,
		  let cekHex=request["cek_hex"]as?String,
		  let gHex=request["g_hex"]as?String,
		  let payloadInfoDict=request["payload_info"]as?[String:Any] else {
		sendError("missing schedule fields")
		exit(1)
	}

	let protocolId=Array(protocolIdStr.utf8)
	let cek=try Hex.decode(cekHex)
	let g=try Hex.decode(gHex)

	guard let aeadId=payloadInfoDict["aead_id"]as?Int,
		  let segmentMax=payloadInfoDict["segment_max"]as?Int,
		  let kdfId=payloadInfoDict["kdf_id"]as?Int,
		  let snapId=payloadInfoDict["snap_id"]as?Int,
		  let nonceMode=payloadInfoDict["nonce_mode"]as?Int,
		  let epochLength=payloadInfoDict["epoch_length"]as?Int,
		  let saltHex=payloadInfoDict["salt_hex"]as?String else {
		sendError("invalid payload_info")
		exit(1)
	}

	let salt=try Hex.decode(saltHex)

	let aeadID=try toUInt16(aeadId)
	let segMax=try toUInt32(segmentMax)
	let kdfID=try toUInt16(kdfId)
	let snapID=try toUInt16(snapId)
	let nonceModeRaw=try toUInt8(nonceMode)
	let epochLen=try toUInt8(epochLength)

	guard let nonceMode=PayloadInfo.NonceMode(rawValue:nonceModeRaw) else {
		throw CLIError.invalidNonceMode(nonceMode)
	}

	let info=PayloadInfo(
		aeadID:aeadID,
		segmentMax:segMax,
		kdfID:kdfID,
		snapID:snapID,
		nonceMode:nonceMode,
		epochLength:epochLen,
		salt:salt
	)

	let schedule=try PayloadSchedule(
		protocolID:protocolId,
		cek:cek,
		payloadInfo:info,
		globalAssociatedData:g
	)

	var response:[String:String]=[
		"commitment_hex":Hex.encode(schedule.commitment),
		"payload_key_hex":Hex.encode(keyBytes(schedule.payloadKey)),
		"acc_key_hex":Hex.encode(keyBytes(schedule.snapKey)),
	]

	if schedule.payloadInfo.nonceMode == .derived {
		response["nonce_base_hex"]=Hex.encode(keyBytes(schedule.nonceBase!))
	}

	sendResponse(response)
}

func handleSealSegment(request:[String:Any])throws {
	// Build schedule first
	guard let protocolIdStr=request["protocol_id"]as?String,
		  let cekHex=request["cek_hex"]as?String,
		  let gHex=request["g_hex"]as?String,
		  let payloadInfoDict=request["payload_info"]as?[String:Any],
		  let index=request["index"]as?Int,
		  let isFinal=request["is_final"]as?Int,
		  let plaintextHex=request["plaintext_hex"]as?String else {
		sendError("missing seal_segment fields")
		exit(1)
	}

	let protocolId=Array(protocolIdStr.utf8)
	let cek=try Hex.decode(cekHex)
	let g=try Hex.decode(gHex)
	let plaintext=try Hex.decode(plaintextHex)

	guard let aeadId=payloadInfoDict["aead_id"]as?Int,
		  let segmentMax=payloadInfoDict["segment_max"]as?Int,
		  let kdfId=payloadInfoDict["kdf_id"]as?Int,
		  let snapId=payloadInfoDict["snap_id"]as?Int,
		  let nonceMode=payloadInfoDict["nonce_mode"]as?Int,
		  let epochLength=payloadInfoDict["epoch_length"]as?Int,
		  let saltHex=payloadInfoDict["salt_hex"]as?String else {
		sendError("invalid payload_info")
		exit(1)
	}

	let salt=try Hex.decode(saltHex)

	let aeadID=try toUInt16(aeadId)
	let segMax=try toUInt32(segmentMax)
	let kdfID=try toUInt16(kdfId)
	let snapID=try toUInt16(snapId)
	let nonceModeRaw=try toUInt8(nonceMode)
	let epochLen=try toUInt8(epochLength)

	guard let nonceMode=PayloadInfo.NonceMode(rawValue:nonceModeRaw) else {
		throw CLIError.invalidNonceMode(nonceMode)
	}

	let info=PayloadInfo(
		aeadID:aeadID,
		segmentMax:segMax,
		kdfID:kdfID,
		snapID:snapID,
		nonceMode:nonceMode,
		epochLength:epochLen,
		salt:salt
	)

	let schedule=try PayloadSchedule(
		protocolID:protocolId,
		cek:cek,
		payloadInfo:info,
		globalAssociatedData:g
	)

	let posIndex=try toUInt64(index)
	let position=SegmentPosition(index:posIndex,isFinal:isFinal==1)

	var ctBytes:[UInt8]
	var resultNonce:[UInt8]

	if schedule.payloadInfo.nonceMode == .random {
		guard let nonceHex=request["nonce_hex"]as?String else {
			sendError("random mode requires nonce_hex")
			exit(1)
		}
		let nonce=try Hex.decode(nonceHex)
		let result=try Segment.encryptRandom(
			schedule:schedule,
			position:position,
			associatedData:[],
			plaintext:plaintext,
			nonce:nonce
		)
		ctBytes=Array(result.ciphertext)
		resultNonce=result.nonce
	} else {
		let result=try Segment.encryptDerivedUnmetered(
			schedule:schedule,
			position:position,
			associatedData:[],
			plaintext:plaintext
		)
		ctBytes=Array(result)
		let nonceBaseKey=schedule.nonceBase!
		let nonceBase=keyBytes(nonceBaseKey)
		resultNonce=try Segment.derivedNonce(nonceBase:nonceBase,position:position)
	}

	let tagLength=schedule.aead.tagLength
	let splitPoint=ctBytes.count-tagLength

	let response:[String:String]=[
		"ct_hex":Hex.encode(Array(ctBytes.prefix(splitPoint))),
		"tag_hex":Hex.encode(Array(ctBytes.suffix(tagLength))),
		"nonce_hex":Hex.encode(resultNonce),
	]

	sendResponse(response)
}

func handleOpenSegment(request:[String:Any])throws {
	guard let protocolIdStr=request["protocol_id"]as?String,
		  let cekHex=request["cek_hex"]as?String,
		  let gHex=request["g_hex"]as?String,
		  let payloadInfoDict=request["payload_info"]as?[String:Any],
		  let index=request["index"]as?Int,
		  let isFinal=request["is_final"]as?Int,
		  let ctHex=request["ct_hex"]as?String,
		  let tagHex=request["tag_hex"]as?String,
		  let nonceHex=request["nonce_hex"]as?String else {
		sendError("missing open_segment fields")
		exit(1)
	}

	let protocolId=Array(protocolIdStr.utf8)
	let cek=try Hex.decode(cekHex)
	let g=try Hex.decode(gHex)
	let ct=try Hex.decode(ctHex)
	let tag=try Hex.decode(tagHex)
	let nonce=try Hex.decode(nonceHex)
	let ciphertext=ct+tag

	guard let aeadId=payloadInfoDict["aead_id"]as?Int,
		  let segmentMax=payloadInfoDict["segment_max"]as?Int,
		  let kdfId=payloadInfoDict["kdf_id"]as?Int,
		  let snapId=payloadInfoDict["snap_id"]as?Int,
		  let nonceMode=payloadInfoDict["nonce_mode"]as?Int,
		  let epochLength=payloadInfoDict["epoch_length"]as?Int,
		  let saltHex=payloadInfoDict["salt_hex"]as?String else {
		sendError("invalid payload_info")
		exit(1)
	}

	let salt=try Hex.decode(saltHex)

	let aeadID=try toUInt16(aeadId)
	let segMax=try toUInt32(segmentMax)
	let kdfID=try toUInt16(kdfId)
	let snapID=try toUInt16(snapId)
	let nonceModeRaw=try toUInt8(nonceMode)
	let epochLen=try toUInt8(epochLength)

	guard let nonceMode=PayloadInfo.NonceMode(rawValue:nonceModeRaw) else {
		throw CLIError.invalidNonceMode(nonceMode)
	}

	let info=PayloadInfo(
		aeadID:aeadID,
		segmentMax:segMax,
		kdfID:kdfID,
		snapID:snapID,
		nonceMode:nonceMode,
		epochLength:epochLen,
		salt:salt
	)

	let schedule=try PayloadSchedule(
		protocolID:protocolId,
		cek:cek,
		payloadInfo:info,
		globalAssociatedData:g
	)

	let posIndex=try toUInt64(index)
	let position=SegmentPosition(index:posIndex,isFinal:isFinal==1)

	var plaintext:[UInt8]
	if schedule.payloadInfo.nonceMode == .random {
		plaintext=try Segment.decryptRandom(
			schedule:schedule,
			position:position,
			associatedData:[],
			nonce:nonce,
			ciphertext:ciphertext
		)
	} else {
		plaintext=try Segment.decryptDerived(
			schedule:schedule,
			position:position,
			associatedData:[],
			ciphertext:ciphertext
		)
	}

	let response:[String:String]=[
		"plaintext_hex":Hex.encode(plaintext)
	]

	sendResponse(response)
}

main()
