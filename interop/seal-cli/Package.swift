// swift-tools-version:6.0
import PackageDescription

let package=Package(
	name:"seal-cli",
	platforms:[.macOS(.v14)],
	dependencies:[
		.package(
			url:"https://github.com/germ-network/swift-raae",
			revision:"f2ce71641b933e5dd02b1a4f5dabeb85cbd77c2e"
		),
	],
	targets:[
		.executableTarget(
			name:"seal-cli",
			dependencies:[
				.product(name:"RAAE",package:"swift-raae"),
			]
		),
	]
)
