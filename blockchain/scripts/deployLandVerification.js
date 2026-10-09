const hre = require("hardhat");

async function main() {
  console.log("==================================================");
  console.log("Deploying LandVerification contract...");
  console.log("Network:", hre.network.name);

  const [deployer] = await hre.ethers.getSigners();
  if (deployer) {
    console.log("Deployer / Initial Operator Address:", deployer.address);
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log("Deployer Balance:", hre.ethers.formatEther(balance), "BNB");
  }

  const LandVerification = await hre.ethers.getContractFactory("LandVerification");
  const landVerification = await LandVerification.deploy();

  await landVerification.waitForDeployment();

  const address = await landVerification.getAddress();

  console.log("LandVerification deployed successfully to:", address);
  console.log("Transaction hash:", landVerification.deploymentTransaction().hash);

  const network = await hre.ethers.provider.getNetwork();
  const deploymentInfo = {
    contract: "LandVerification",
    network: hre.network.name,
    contractAddress: address,
    deploymentHash: landVerification.deploymentTransaction().hash,
    deployer: deployer ? deployer.address : "unknown",
    timestamp: new Date().toISOString(),
    chainId: Number(network.chainId),
  };

  console.log("\nDeployment Details:\n", JSON.stringify(deploymentInfo, null, 2));

  console.log("\nNext Steps:");
  console.log(`1. Set in .env and in the Catalyst AppSail console: LAND_VERIFICATION_CONTRACT_ADDRESS=${address}`);
  console.log(`   SMART_CONTRACT_PROVIDER=bsc  BSC_CHAIN_ID=${Number(network.chainId)}`);
  console.log("2. Restart / redeploy the API.");

  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    console.log("\nTo verify contract on BscScan, run:");
    console.log(`npx hardhat verify --network ${hre.network.name} ${address}`);
  }
  console.log("==================================================");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
