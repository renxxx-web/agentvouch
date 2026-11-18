// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAgentId — interface for the Binance Agent ID registry (BSC)
/// @notice Agent ID is a soulbound ERC-721 "handle" registry deployed at
///         0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F on BNB Smart Chain.
///         Each address holds at most one handle. Handles are bare labels
///         (e.g. "renx"); the ".ai" suffix is display-only and is never part
///         of the stored handle.
interface IAgentId {
    /// @notice Returns 1 if `owner` holds an Agent ID, otherwise 0.
    function balanceOf(address owner) external view returns (uint256);

    /// @notice Resolves a bare handle label (e.g. "renx", NOT "renx.ai") to
    ///         its owner. Returns address(0) if the handle is unregistered.
    function ownerOfHandle(string calldata handle) external view returns (address);

    /// @notice Returns the bare handle label held by `owner`, or "" if none.
    function handleOf(address owner) external view returns (string memory);
}
