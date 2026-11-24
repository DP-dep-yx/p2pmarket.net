// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockEthUsdFeed
 * @notice Deterministic stand-in for the Chainlink ETH/USD aggregator — TESTNET ONLY.
 * @dev Use for the Base Sepolia rehearsal so the whole $1 fee path of TrustMarketsRegistry
 *      can be exercised without depending on a live testnet feed. Implements the same
 *      minimal interface the registry expects (latestRoundData, 8-dp answer).
 *      Mainnet deploys MUST use the real feed instead:
 *      Base mainnet ETH/USD = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70
 */
contract MockEthUsdFeed {
    int256 public price;        // USD per 1 ETH, 8 decimals (e.g. 168919000000 = $1689.19)
    uint80 public roundId;

    event PriceUpdated(uint80 indexed roundId, int256 price);

    constructor(int256 _price8dp) {
        require(_price8dp > 0, "Price must be positive");
        price = _price8dp;
        roundId = 1;
    }

    /// @dev Simulates a new Chainlink round with a fresh timestamp.
    function setPrice(int256 _price8dp) external {
        require(_price8dp > 0, "Price must be positive");
        price = _price8dp;
        roundId++;
        emit PriceUpdated(roundId, _price8dp);
    }

    /// @notice Same signature as AggregatorV3Interface.latestRoundData().
    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, price, block.timestamp, block.timestamp, roundId);
    }
}
